// ── VGC Browser — profile manager ────────────────────────────────────────────
// Owns the runtime lifecycle of profiles: spawning an isolated Chromium per
// profile and tracking which are running. Each profile gets its own
// --user-data-dir (fully isolated cookies/cache/storage) and proxy.
//
// Phase 0 scope:
//   ✓ isolated user-data-dir per profile
//   ✓ per-profile proxy (no-auth)
//   ✓ UA / window-size / language passed as launch flags
//   ✓ CDP over a PIPE (--remote-debugging-pipe, fds 3/4) — no TCP debug port, so
//     Google sign-in no longer flags it "this browser or app may not be secure"
// Not yet (later phases):
//   • CDP fingerprint injection (canvas/webgl/audio/webrtc) — Phase 1
//   • proxy authentication via local relay — Phase 3

import { spawn, type ChildProcess } from 'child_process'
import type { Readable, Writable } from 'node:stream'
import { createHash } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync, promises as fs } from 'fs'
import { app, BrowserWindow } from 'electron'
import type { Cookie, DataSyncState, Fingerprint, ProfileRuntimeState } from '../shared/types'
import { ensureEngine, type EngineProgress } from './engine-download'
import { resolveSystemBrowser } from './engine'
import { checkProxy } from './proxy-check'
import { localeForCountry } from '../shared/fingerprint'
import { getProfile, patchProfile } from './store'
import { getSettings } from './settings'
import { attachInjector, type InjectorHandle } from './cdp-injector'
import { startRelay, proxyNeedsRelay, type RelayHandle } from './proxy-relay'
import { seedFromString } from './fingerprint-script'
import {
  downloadProfileData,
  uploadProfileData,
  downloadProfileCookies,
  uploadProfileCookies
} from './cloud-data'
import { getCloudSession } from './session'
import { getAccountSecret, isEncryptionActive } from './account-secret'

interface RunningProfile {
  proc: ChildProcess
  state: ProfileRuntimeState
  injector?: InjectorHandle
  relay?: RelayHandle
  /** Interval that polls + persists open tabs for cross-machine tab sync. */
  tabPoll?: ReturnType<typeof setInterval>
}

/** Default fingerprint validation target opened by "Kiểm tra fingerprint". */
const DEFAULT_TEST_URL = 'https://abrahamjuliot.github.io/creepjs/'

const running = new Map<string, RunningProfile>()
// Latest decrypted-cookie snapshot per running profile (refreshed by a poll), so
// the close handler can upload it even when the browser is already gone (the user
// closed the window directly → CDP is dead by the time 'exit' fires).
const lastCookieSnapshot = new Map<string, Cookie[]>()

/**
 * Serialize the session-data operations (cloud download-before-open and
 * upload-on-close) PER profile. Without this, closing a profile (which waits then
 * zips+uploads the live user-data-dir) can race a re-open of the same profile
 * (which extracts the cloud zip over that same dir) → a half-written zip is
 * uploaded, or the freshly-launched Chromium has its SQLite files overwritten
 * underneath it → a corrupt / logged-out session.
 */
const dataLocks = new Map<string, Promise<unknown>>()
function withDataLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = (dataLocks.get(id) ?? Promise.resolve()).catch(() => {})
  const run = prev.then(fn)
  dataLocks.set(id, run)
  void run
    .catch(() => {})
    .finally(() => {
      if (dataLocks.get(id) === run) dataLocks.delete(id)
    })
  return run
}

/**
 * Stable per-profile secret for the VGC Core engine's PORTABLE os_crypt key
 * (--vgc-crypt-secret). Derived from the cloud account uid + profile id, so it is
 * IDENTICAL on every machine signed into the same account → cookies + saved
 * passwords encrypted on one machine decrypt on another (macOS ⇄ Windows, both
 * running a patched VGC Core engine). Empty when signed out — cross-machine sync is
 * off then anyway, so the engine keeps its normal machine-bound key.
 */
async function cryptSecretFor(id: string): Promise<string> {
  // The random per-account secret (not derivable from public ids) → the ONE stable
  // portable key. Now persisted OS-encrypted on first fetch, so it survives blips.
  const accSecret = await getAccountSecret()
  if (accSecret) return createHash('sha256').update(`${accSecret}:${id}`).digest('hex')
  // No account secret available. If this account has EVER encrypted a profile (a
  // persisted marker proves it), the on-disk Cookies + Login Data are sealed with the
  // account key. Handing the engine ANY other key — the old uid-derived fallback OR
  // the engine's machine key — would make them undecryptable: silent logout of every
  // site and PERMANENT loss of saved passwords. So we REFUSE to open with a wrong key
  // (the launcher surfaces a "thử lại" message) instead of corrupting the session.
  // (The previous `sha256('vgc-os-crypt:uid:id')` fallback was exactly this divergent
  // key and is removed.)
  if (getCloudSession() && isEncryptionActive()) {
    throw new Error('VGC_CRYPT_KEY_UNAVAILABLE')
  }
  // Genuinely fresh / never-encrypted account (or signed out and never used the
  // portable key) → let the engine keep its normal machine-bound key.
  return ''
}

function profileDataDir(id: string): string {
  const dir = join(app.getPath('userData'), 'profiles', id)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ── Tab sync ─────────────────────────────────────────────────────────────────
// The list of open tabs is persisted INSIDE the synced user-data-dir
// (Default/vgc-open-tabs.json), so the existing cloud data zip carries it to every
// machine. On open we reopen those tabs; while running we refresh the file so the
// latest set is what syncs on close.
function openTabsFile(id: string): string {
  return join(profileDataDir(id), 'Default', 'vgc-open-tabs.json')
}

async function readSavedTabs(id: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(openTabsFile(id), 'utf-8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return [] // no saved tabs yet (first open) or unreadable
  }
}

async function writeSavedTabs(id: string, urls: string[]): Promise<void> {
  try {
    await fs.mkdir(join(profileDataDir(id), 'Default'), { recursive: true })
    await fs.writeFile(openTabsFile(id), JSON.stringify(urls), 'utf-8')
  } catch {
    // best-effort — tab sync must never break a launch
  }
}

/**
 * Remove Chromium's OWN session-restore state so it doesn't reopen tabs natively.
 * We restore tabs ourselves (readSavedTabs → openUrl); without this, a synced
 * profile gets DOUBLE tabs — Chromium restores the synced session AND we reopen the
 * saved set. Deletes both the freshly-extracted (synced) and any stale local copy.
 */
async function clearChromiumSession(id: string): Promise<void> {
  const def = join(profileDataDir(id), 'Default')
  const targets = ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']
  await Promise.all(
    targets.map((t) => fs.rm(join(def, t), { recursive: true, force: true }).catch(() => {}))
  )
}

function broadcast(state: ProfileRuntimeState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('profile:status', state)
  }
}

function broadcastEngine(id: string, p: EngineProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('engine:progress', { id, ...p })
  }
}

function broadcastData(state: DataSyncState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('profile:dataSync', state)
  }
}

export function getRuntimeState(id: string): ProfileRuntimeState {
  return running.get(id)?.state ?? { id, status: 'stopped' }
}

export function allRuntimeStates(): ProfileRuntimeState[] {
  return [...running.values()].map((r) => r.state)
}

let isQuitting = false

/** When a single profile closes (app stays open): auto-upload its session. */
async function syncDataOnClose(id: string): Promise<void> {
  try {
    if (isQuitting) return // the app-quit path uploads everything via stopAllAndSync
    if (!getCloudSession()) return
    // Hold the per-profile lock for the WHOLE flush+upload, and take it BEFORE the
    // flush-grace sleep. Otherwise a reopen within ~1.2s takes the lock first,
    // downloads a stale cloud snapshot over the freshest local dir, and this delayed
    // upload then zips the just-relaunched (mid-write) profile → corrupt/downgraded
    // session propagates to every machine. Holding the lock makes a reopen wait.
    await withDataLock(id, async () => {
      // small grace so Chromium finishes flushing Cookies/Login Data SQLite files
      await new Promise((r) => setTimeout(r, 1200))
      broadcastData({ id, phase: 'upload', message: 'Đang lưu phiên lên cloud…' })
      await uploadProfileData(id)
      // Cross-machine login: upload the decrypted cookies separately (plaintext) so
      // they survive the trip to a different-OS machine where the encrypted Cookies
      // DB can't be read.
      const cookies = lastCookieSnapshot.get(id)
      if (cookies && cookies.length) {
        try {
          await uploadProfileCookies(id, cookies)
        } catch (e) {
          console.error('[vgc] upload cookies lỗi:', e)
        }
      }
    })
    broadcastData({ id, phase: 'done' })
  } catch (err) {
    broadcastData({ id, phase: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Called on app quit: stop every running profile and upload each one's session to
 * the cloud BEFORE the app exits. main awaits this so nothing is lost on close.
 */
export async function stopAllAndSync(): Promise<void> {
  isQuitting = true
  const ids = [...running.keys()]
  for (const id of ids) stopProfile(id)
  if (ids.length === 0 || !getCloudSession()) return
  // give Chromium a moment to flush its SQLite files and release locks
  await new Promise((r) => setTimeout(r, 1500))
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        broadcastData({ id, phase: 'upload', message: 'Đang lưu phiên lên cloud trước khi thoát…' })
        await uploadProfileData(id)
        const cookies = lastCookieSnapshot.get(id)
        if (cookies && cookies.length) await uploadProfileCookies(id, cookies)
        broadcastData({ id, phase: 'done' })
      } catch {
        // best-effort — don't block quit on a single failure
      }
    })
  )
}

/**
 * Spawn the engine and resolve only once it has actually started (the child's
 * 'spawn' event). Rejects on failure — INCLUDING async failures: on Windows a
 * CreateProcess error like `spawn UNKNOWN` (engine blocked by antivirus / locked /
 * corrupt) is emitted on the 'error' event AFTER spawn() returns, so a plain
 * try/catch around spawn() never sees it. Waiting on the events catches both the
 * sync throw and the async 'error' — which is what lets the system-browser
 * fallback actually kick in instead of the launch dying with "spawn UNKNOWN".
 */
function spawnAndWait(
  exe: string,
  args: string[],
  usePipe: boolean,
  env?: NodeJS.ProcessEnv
): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    let proc: ChildProcess
    try {
      // Normal launch: stdio fds 3 & 4 are the CDP pipe (--remote-debugging-pipe) — we
      // WRITE commands to fd 3 and READ events from fd 4, no TCP debug port.
      // Clean-login launch (usePipe=false): NO CDP at all, so Google's sign-in sees an
      // ordinary browser and lets you log in; the session persists in the profile dir.
      proc = spawn(exe, args, {
        detached: false,
        env,
        stdio: usePipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore'
      })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    let settled = false
    const onSpawn = (): void => {
      if (settled) return
      settled = true
      proc.removeListener('error', onError)
      resolve(proc)
    }
    const onError = (err: Error): void => {
      if (settled) return
      settled = true
      proc.removeListener('spawn', onSpawn)
      reject(err)
    }
    proc.once('spawn', onSpawn)
    proc.once('error', onError)
  })
}

export async function launchProfile(
  id: string,
  opts: { headless?: boolean; cleanLogin?: boolean } = {}
): Promise<ProfileRuntimeState> {
  const existing = running.get(id)
  if (existing) return existing.state

  const profile = await getProfile(id)
  if (!profile) throw new Error(`Không tìm thấy profile: ${id}`)

  // GoLogin model: open with the engine's NATIVE C++ fingerprint spoofing and DO NOT
  // attach a CDP debugger — Google blocks browsers with an active CDP session at
  // sign-in, so this is what makes Google login work. nativeMode is ON by default;
  // the "Đăng nhập Google" button (opts.cleanLogin) always skips CDP too. The headless
  // automation API path keeps CDP (it has no human signing into Google).
  const settings = await getSettings()
  const skipCdp = !opts.headless && (opts.cleanLogin === true || settings.nativeMode !== false)
  const cleanLogin = opts.cleanLogin === true

  let enginePath: string
  try {
    enginePath = await ensureEngine((p) => broadcastEngine(id, p))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    broadcast({ id, status: 'error', error: msg })
    throw new Error(msg)
  }

  const userDataDir = profileDataDir(id)

  // GoLogin-style AUTO-sync: whenever logged into cloud, ALWAYS pull the latest
  // session (cookies/logins/storage) from the cloud before opening — the cloud is
  // the source of truth. 404 (nothing uploaded yet, e.g. a brand-new profile) is
  // fine and we just open with whatever is local.
  let syncedCookies: Cookie[] = []
  if (getCloudSession()) {
    try {
      broadcastData({ id, phase: 'download', message: 'Đang đồng bộ dữ liệu từ cloud…' })
      // Held under the per-profile data lock so a still-running close-upload of the
      // SAME profile finishes before we extract the cloud zip over its dir.
      const got = await withDataLock(id, () => downloadProfileData(id))
      // Plaintext cookies synced from any machine → seeded into the engine below so
      // the profile is already logged in even across macOS ⇄ Windows.
      syncedCookies = await downloadProfileCookies(id).catch(() => [])
      broadcastData({ id, phase: 'done', message: got ? 'Đã đồng bộ dữ liệu mới nhất' : undefined })
    } catch (err) {
      broadcastData({ id, phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // CDP mode: the injector reopens tabs itself, so strip Chromium's own restore state
  // to avoid opening every tab TWICE. Native mode (no injector): KEEP the session so
  // Chrome restores the user's own tabs (via --restore-last-session below).
  if (!skipCdp) await clearChromiumSession(id)

  // If opening with the GENUINE system Chrome (useSystemBrowser), the dir may have been
  // written by a newer engine (Chromium 149) → Chrome refuses "profile from a newer
  // version". Drop the version marker so any Chrome opens it (cookies/logins untouched).
  if (settings.useSystemBrowser) {
    await fs.rm(join(profileDataDir(id), 'Last Version'), { force: true }).catch(() => {})
  }

  // ── Fingerprint coherence: align timezone / geolocation / locale / WebRTC IP to
  // the proxy's EXIT IP so they can't contradict each other. A US proxy reporting a
  // Vietnam timezone (or leaking the real public IP via WebRTC) is a classic bot
  // tell. Looked up live so it works with rotating residential proxies; capped at
  // 6s and falls back to the profile's stored fingerprint so launch never hangs.
  let fp: Fingerprint = profile.fingerprint
  if (profile.proxy && profile.proxy.type !== 'none' && profile.proxy.host && profile.proxy.port) {
    try {
      broadcastData({ id, phase: 'download', message: 'Đang khớp múi giờ/vị trí theo proxy…' })
      const geo = await Promise.race([
        checkProxy(profile.proxy),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000))
      ])
      if (geo && geo.ok) {
        const next: Fingerprint = { ...fp }
        if (geo.timezone) next.timezone = geo.timezone
        if (geo.ip) next.webrtcPublicIp = geo.ip
        if (typeof geo.latitude === 'number' && typeof geo.longitude === 'number') {
          next.geolocation = { latitude: geo.latitude, longitude: geo.longitude, accuracy: 100 }
        }
        const loc = localeForCountry(geo.countryCode)
        if (loc) {
          next.language = loc.language
          next.languages = loc.languages
        }
        fp = next
      }
      broadcastData({ id, phase: 'done' })
    } catch {
      // keep the profile's stored fingerprint — coherence is best-effort
    }
  }

  const args: string[] = [
    `--user-data-dir=${userDataDir}`,
    // NB: we deliberately do NOT pass --disable-blink-features=AutomationControlled.
    // In native mode there's no CDP and no --enable-automation, so navigator.webdriver
    // is already false — the flag was redundant AND made Chrome show the yellow
    // "unsupported command-line flag" warning bar on every page.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    // No "Chrome didn't shut down correctly — restore pages?" bubble (we manage tabs).
    '--hide-crash-restore-bubble',
    `--lang=${fp.language}`,
    `--window-size=${fp.screen.width},${fp.screen.height}`,
    `--user-agent=${fp.userAgent}`,
    // Make navigator.userAgentData (UA Client Hints) report the SAME Chrome version as
    // the UA string above. Without this the engine leaks its own build version (151)
    // while the UA string says the profile's version (e.g. 149) — that mismatch is a
    // hard anti-bot tell that makes Cloudflare's challenge loop. The engine reads this
    // for its UA-CH brand list + fullVersionList + high-entropy full_version.
    `--vgc-ua-full-version=${fp.uaFullVersion || fp.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || ''}`,
    // UA Client Hints OS spoof: make Sec-CH-UA-Platform / platformVersion / architecture
    // match the profile's CLAIMED OS (from its UA), not the host machine. A Windows-UA
    // profile running on this Mac otherwise leaks platform "macOS" + a mac version/arch in
    // UA-CH — a blatant OS mismatch vs the Windows UA that makes Cloudflare's challenge loop.
    ...(() => {
      // Apple-Silicon Macs report Sec-CH-UA-Arch "arm" (while the UA still says "Intel
      // Mac OS X" — frozen). A mac profile whose WebGL renderer is an Apple GPU must
      // therefore say arm, not x86, or the arch contradicts the GPU. Android reports an
      // empty arch + bitness and the mobile bit; desktop is 64-bit.
      const macArm = /apple/i.test(fp.webgl?.renderer || '')
      const plat =
        fp.platform === 'Win32' || profile.os === 'windows'
          ? { os: 'Windows', arch: 'x86', bitness: '64', ver: fp.uaPlatformVersion || '15.0.0' }
          : fp.platform === 'MacIntel' || profile.os === 'macos'
            ? { os: 'macOS', arch: macArm ? 'arm' : 'x86', bitness: '64', ver: fp.uaPlatformVersion || '14.6.0' }
            : profile.os === 'android'
              ? { os: 'Android', arch: '', bitness: '', ver: fp.uaPlatformVersion || '14.0.0' }
              : { os: 'Linux', arch: 'x86', bitness: '64', ver: fp.uaPlatformVersion || '' }
      return [
        `--vgc-ua-platform=${plat.os}`,
        `--vgc-ua-platform-version=${plat.ver}`,
        `--vgc-ua-arch=${plat.arch}`,
        `--vgc-ua-bitness=${plat.bitness}`
      ]
    })(),
    // VGC Core native fingerprint switches (stock Chrome ignores unknown flags).
    `--vgc-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--vgc-device-memory=${fp.deviceMemory}`,
    `--vgc-platform=${fp.platform}`,
    `--vgc-webgl-vendor=${fp.webgl.vendor}`,
    `--vgc-webgl-renderer=${fp.webgl.renderer}`,
    // IANA timezone → engine overrides ICU default zone (JS Date / Intl) natively.
    `--vgc-timezone=${fp.timezone}`,
    // navigator.languages spoof (proxy-country locale from localeForCountry) — native
    // because --lang is a no-op on macOS, which leaked the host's real OS language on
    // every profile regardless of the proxy country.
    `--vgc-accept-languages=${(fp.languages && fp.languages.length ? fp.languages : [fp.language]).join(',')}`,
    // Unique per-profile seed → engine seeds canvas/audio noise so every Chrome differs.
    `--vgc-seed=${seedFromString(id)}`,
    // Profile name shown in the OS window title (title bar / Cmd-Tab / Dock) so you
    // can tell which profile a window is — NOT in document.title, so it never leaks
    // to the page. GoLogin-style profile labelling.
    `--vgc-profile-name=${profile.name}`
  ]

  // Portable os_crypt key (VGC Core engine): same secret on every machine of this
  // account → saved passwords + cookies encrypted on one machine decrypt on another.
  // Passed via the ENVIRONMENT (VGC_CRYPT_SECRET), NOT argv — argv is readable via
  // `ps` by any other local user, and this secret decrypts the profile's cookies +
  // saved passwords. The engine reads env first, falling back to the old switch.
  let cryptSecret: string
  try {
    cryptSecret = await cryptSecretFor(id)
  } catch (e) {
    // Encryption key momentarily unavailable (network blip fetching account_secrets on
    // a machine with no persisted copy yet). Opening now would use a wrong os_crypt key
    // and log the profile out of everything → abort with a clear, retryable message.
    const msg =
      e instanceof Error && e.message === 'VGC_CRYPT_KEY_UNAVAILABLE'
        ? 'Chưa lấy được khoá mã hoá tài khoản (mạng chập chờn). Hãy kiểm tra mạng và mở lại — KHÔNG mở bằng khoá sai để tránh mất đăng nhập.'
        : e instanceof Error
          ? e.message
          : String(e)
    broadcast({ id, status: 'error', error: msg })
    throw new Error(msg)
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  if (cryptSecret) childEnv.VGC_CRYPT_SECRET = cryptSecret

  // Per-profile proxy. Authenticated (and SOCKS5-auth) proxies go through a local
  // relay because Chromium can't pass credentials via the flag; no-auth proxies
  // are handed to Chromium directly.
  let relay: RelayHandle | undefined
  const hasProxy = profile.proxy.type !== 'none' && !!profile.proxy.host && !!profile.proxy.port
  if (hasProxy) {
    if (proxyNeedsRelay(profile.proxy)) {
      relay = await startRelay(profile.proxy)
      args.push(`--proxy-server=http://127.0.0.1:${relay.port}`)
    } else {
      const scheme = profile.proxy.type === 'socks5' ? 'socks5' : 'http'
      args.push(`--proxy-server=${scheme}://${profile.proxy.host}:${profile.proxy.port}`)
    }
  }

  // WebRTC leak guard. Without a native engine patch, WebRTC's ICE candidate gathering
  // exposes the machine's REAL local + public IP even behind a proxy — which would tie
  // every "different" Gmail back to one real IP. With a proxy, force WebRTC through it
  // only (no real-IP UDP); otherwise at least hide the local network IPs.
  args.push(
    `--force-webrtc-ip-handling-policy=${hasProxy ? 'disable_non_proxied_udp' : 'default_public_interface_only'}`
  )

  // Load unpacked extensions into the profile.
  if (profile.extensions && profile.extensions.length > 0) {
    const list = profile.extensions.join(',')
    args.push(`--load-extension=${list}`, `--disable-extensions-except=${list}`)
  }

  // Headless (used by the automation API).
  if (opts.headless) args.push('--headless=new')

  // CDP over a PIPE only when we actually attach the injector. Native mode / clean
  // login skip it → NO automation session attached → Google sign-in works.
  if (!skipCdp) args.push('--remote-debugging-pipe')

  // Where to land. CDP mode opens about:blank (injector then reopens tabs). Native mode
  // has no injector, so open the profile's start URLs directly. Clean-login → Google.
  if (cleanLogin) {
    args.push('https://accounts.google.com/')
  } else if (skipCdp) {
    // Native mode: let Chrome restore the user's own tabs from last time. If there's a
    // prior session, force-restore it; otherwise (first-ever open) use the start URLs.
    const def = join(userDataDir, 'Default')
    const hasSession =
      existsSync(join(def, 'Current Session')) ||
      existsSync(join(def, 'Last Session')) ||
      existsSync(join(def, 'Sessions'))
    if (hasSession) {
      args.push('--restore-last-session')
    } else {
      const urls = profile.startUrls && profile.startUrls.length ? profile.startUrls : ['about:blank']
      args.push(...urls)
    }
  } else {
    args.push('about:blank')
  }

  broadcast({ id, status: 'starting' })

  // Spawn the engine. CRITICAL: on Windows a CreateProcess failure (errno UNKNOWN
  // — the unsigned VGC Core engine.exe blocked/quarantined by antivirus, locked,
  // or corrupt) is reported ASYNCHRONOUSLY via the child's 'error' event, NOT
  // thrown by spawn(). So we wait on the 'spawn'/'error' events (spawnAndWait)
  // rather than a plain try/catch — otherwise the failure slips past and the
  // profile never opens. On failure we fall back to a system browser (Chrome/Edge),
  // just like the Mac build, so the profile still opens (CDP fingerprint injection
  // still applies; stock Chrome ignores the unknown --vgc-* flags).
  let proc: ChildProcess
  // The engine that ACTUALLY ran (may differ from enginePath if we fall back to a
  // system browser). Drives nativeWebgl below: only the VGC Core engine spoofs
  // WebGL in C++, so only then do we skip the JS getParameter override.
  let actualEngine = enginePath
  try {
    proc = await spawnAndWait(enginePath, args, !skipCdp, childEnv)
  } catch (err) {
    const fallback = resolveSystemBrowser(enginePath)
    if (!fallback) {
      relay?.close()
      const msg =
        'Không mở được engine VGC Core (' +
        (err instanceof Error ? err.message : String(err)) +
        ') và không tìm thấy Chrome/Edge hệ thống để thay thế. Hãy cài Google Chrome trên máy này.'
      broadcast({ id, status: 'error', error: msg })
      throw new Error(msg)
    }
    console.error('[vgc] engine spawn failed, dùng trình duyệt hệ thống thay thế:', err)
    broadcastEngine(id, {
      phase: 'done',
      message: 'Engine bị chặn — đang dùng Chrome hệ thống thay thế'
    })
    try {
      proc = await spawnAndWait(fallback, args, !skipCdp, childEnv)
      actualEngine = fallback
    } catch (err2) {
      relay?.close()
      const msg =
        'Không mở được trình duyệt (cả engine VGC Core lẫn Chrome hệ thống đều lỗi): ' +
        (err2 instanceof Error ? err2.message : String(err2))
      broadcast({ id, status: 'error', error: msg })
      throw new Error(msg)
    }
  }

  const state: ProfileRuntimeState = {
    id,
    status: 'running',
    pid: proc.pid,
    startedAt: new Date().toISOString()
  }
  const entry: RunningProfile = { proc, state, relay }
  running.set(id, entry)
  broadcast(state)

  // Touch lastUsedAt via an atomic patch (re-reads fresh inside the store lock) so a
  // profile edit made while this profile was opening — the cloud download can take
  // several seconds — isn't clobbered by writing back the pre-launch snapshot.
  await patchProfile(id, { lastUsedAt: new Date().toISOString() })

  proc.on('exit', () => {
    if (entry.tabPoll) clearInterval(entry.tabPoll)
    entry.injector?.dispose()
    entry.relay?.close()
    running.delete(id)
    broadcast({ id, status: 'stopped' })
    // GoLogin-style sync-on-close: push the freshest session back to the cloud.
    void syncDataOnClose(id)
  })
  proc.on('error', (err) => {
    entry.injector?.dispose()
    entry.relay?.close()
    running.delete(id)
    broadcast({ id, status: 'error', error: String(err) })
  })

  // Native mode / clean login: NO CDP injector (that's the whole point — Google must
  // see an ordinary browser). The engine still spoofs the fingerprint natively (C++).
  // The session is saved to the profile dir and synced on close.
  if (skipCdp) return state

  // Attach the fingerprint injector (UA/Client Hints/timezone/geo + JS stealth),
  // then open the profile's start URLs through it so they get the overrides.
  try {
    // Only the VGC Core engine (.app on Mac) spoofs WebGL natively → skip the JS
    // override there to avoid a redundant, detectable getParameter patch.
    const nativeWebgl = process.platform === 'darwin' && actualEngine.includes('VGC Core.app')
    const injector = await attachInjector(
      { ...profile, fingerprint: fp },
      { write: proc.stdio[3] as Writable, read: proc.stdio[4] as Readable },
      { nativeWebgl, seedCookies: syncedCookies }
    )
    // The browser may have exited while we were attaching (user closed the lone
    // window, engine crashed on a bad flag). The exit handler already ran and
    // removed us from `running`; assigning + polling now would leak the CDP socket
    // and a 5s interval against a dead port. Bail out cleanly.
    if (!running.has(id)) {
      injector.dispose()
      return state
    }
    entry.injector = injector
    // Tab sync: reopen the tabs that were open last time (synced from any machine
    // via the cloud data zip). First-ever open (no saved tabs) → use start URLs.
    const savedTabs = await readSavedTabs(id)
    const toOpen = savedTabs.length > 0 ? savedTabs : profile.startUrls
    for (const url of toOpen) {
      await entry.injector.openUrl(url)
    }
    // Refresh the saved-tabs file every 5s so the latest set is what syncs on close
    // (covers the user opening/closing tabs, even when they close the window directly).
    entry.tabPoll = setInterval(() => {
      void (async () => {
        const urls = (await entry.injector?.getOpenTabs()) ?? []
        if (urls.length > 0) await writeSavedTabs(id, urls)
        // Snapshot decrypted cookies for cross-machine login sync. Kept in memory and
        // uploaded on close (when the browser — and CDP — may already be gone).
        try {
          const ck = await entry.injector?.getCookies()
          if (ck && ck.length) lastCookieSnapshot.set(id, ck)
        } catch {
          // ignore
        }
      })()
    }, 5000)
  } catch (err) {
    console.error('[vgc] fingerprint injection failed:', err)
  }

  return state
}

/**
 * Open a fingerprint test page inside the profile (launching it first if needed).
 */
export async function checkFingerprint(
  id: string,
  url: string = DEFAULT_TEST_URL
): Promise<void> {
  let entry = running.get(id)
  if (!entry) {
    await launchProfile(id)
    entry = running.get(id)
  }
  if (entry?.injector) {
    await entry.injector.openUrl(url)
  }
}

export function stopProfile(id: string): void {
  const r = running.get(id)
  if (!r) return
  try {
    r.proc.kill()
  } catch {
    // ignore — exit handler will clean up
  }
}

/** Read the live cookies of a running profile (for export). Null if not running. */
export async function getProfileCookies(id: string): Promise<Cookie[] | null> {
  const r = running.get(id)
  if (!r?.injector) return null
  return r.injector.getCookies()
}

/** Default warm-up sites for the cookie robot. */
const WARMUP_URLS = [
  'https://www.google.com',
  'https://www.youtube.com',
  'https://www.wikipedia.org',
  'https://www.amazon.com',
  'https://www.bing.com'
]

/**
 * Cookie robot: launch the profile (if needed) and visit warm-up sites with a
 * delay between each so the profile accumulates realistic cookies/history.
 */
export async function cookieRobot(id: string, urls: string[] = WARMUP_URLS): Promise<void> {
  let entry = running.get(id)
  if (!entry) {
    await launchProfile(id)
    entry = running.get(id)
  }
  if (!entry?.injector) return
  for (const url of urls) {
    await entry.injector.openUrl(url)
    await new Promise((r) => setTimeout(r, 3000))
  }
}

/** Kill every running profile (called on app quit). */
export function stopAll(): void {
  for (const id of [...running.keys()]) stopProfile(id)
}
