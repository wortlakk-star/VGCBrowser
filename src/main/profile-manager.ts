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
import { mkdirSync, promises as fs } from 'fs'
import { app, BrowserWindow } from 'electron'
import type { Cookie, DataSyncState, Fingerprint, ProfileRuntimeState } from '../shared/types'
import { ensureEngine, type EngineProgress } from './engine-download'
import { resolveSystemBrowser } from './engine'
import { checkProxy } from './proxy-check'
import { localeForCountry } from '../shared/fingerprint'
import { getProfile, saveProfile } from './store'
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
import { getAccountSecret } from './account-secret'

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
  // Prefer the random per-account secret (not derivable from public ids).
  const accSecret = await getAccountSecret()
  if (accSecret) return createHash('sha256').update(`${accSecret}:${id}`).digest('hex')
  // Fallback before supabase/account-secrets.sql is run: derive from uid. Still
  // works cross-machine, just derivable; auto-upgrades once the secret exists.
  const uid = getCloudSession()?.uid ?? ''
  if (!uid) return ''
  return createHash('sha256').update(`vgc-os-crypt:${uid}:${id}`).digest('hex')
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
    // small grace so Chromium finishes flushing Cookies/Login Data SQLite files
    await new Promise((r) => setTimeout(r, 1200))
    broadcastData({ id, phase: 'upload', message: 'Đang lưu phiên lên cloud…' })
    // Per-profile lock: a re-open of this profile won't extract the cloud zip over
    // the dir while we're still reading it to build the upload zip.
    await withDataLock(id, () => uploadProfileData(id))
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
function spawnAndWait(exe: string, args: string[], usePipe: boolean): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    let proc: ChildProcess
    try {
      // Normal launch: stdio fds 3 & 4 are the CDP pipe (--remote-debugging-pipe) — we
      // WRITE commands to fd 3 and READ events from fd 4, no TCP debug port.
      // Clean-login launch (usePipe=false): NO CDP at all, so Google's sign-in sees an
      // ordinary browser and lets you log in; the session persists in the profile dir.
      proc = spawn(exe, args, {
        detached: false,
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

  // We reopen tabs ourselves (readSavedTabs → openUrl), so strip Chromium's own
  // session-restore state — otherwise a synced profile opens every tab TWICE
  // (Chromium restores the synced session AND we reopen the saved set).
  await clearChromiumSession(id)

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
    // Engine-level automation hiding — the single biggest signal for Google's
    // "this browser or app may not be secure" block. Removes navigator.webdriver
    // natively AND the other AutomationControlled behaviours that a JS override
    // can't reach. Required (alongside no Runtime.enable) for Google sign-in.
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    // No "Chrome didn't shut down correctly — restore pages?" bubble (we manage tabs).
    '--hide-crash-restore-bubble',
    `--lang=${fp.language}`,
    `--window-size=${fp.screen.width},${fp.screen.height}`,
    `--user-agent=${fp.userAgent}`,
    // VGC Core native fingerprint switches (stock Chrome ignores unknown flags).
    `--vgc-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--vgc-device-memory=${fp.deviceMemory}`,
    `--vgc-webgl-vendor=${fp.webgl.vendor}`,
    `--vgc-webgl-renderer=${fp.webgl.renderer}`,
    // Unique per-profile seed → engine seeds canvas/audio noise so every Chrome differs.
    `--vgc-seed=${seedFromString(id)}`
  ]

  // Portable os_crypt key (VGC Core engine): same secret on every machine of this
  // account → saved passwords + cookies encrypted on one machine decrypt on another.
  const cryptSecret = await cryptSecretFor(id)
  if (cryptSecret) args.push(`--vgc-crypt-secret=${cryptSecret}`)

  // Per-profile proxy. Authenticated (and SOCKS5-auth) proxies go through a local
  // relay because Chromium can't pass credentials via the flag; no-auth proxies
  // are handed to Chromium directly.
  let relay: RelayHandle | undefined
  if (profile.proxy.type !== 'none' && profile.proxy.host && profile.proxy.port) {
    if (proxyNeedsRelay(profile.proxy)) {
      relay = await startRelay(profile.proxy)
      args.push(`--proxy-server=http://127.0.0.1:${relay.port}`)
    } else {
      const scheme = profile.proxy.type === 'socks5' ? 'socks5' : 'http'
      args.push(`--proxy-server=${scheme}://${profile.proxy.host}:${profile.proxy.port}`)
    }
  }

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
    const urls = profile.startUrls && profile.startUrls.length ? profile.startUrls : ['about:blank']
    args.push(...urls)
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
    proc = await spawnAndWait(enginePath, args, !skipCdp)
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
      proc = await spawnAndWait(fallback, args, !skipCdp)
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

  // Touch lastUsedAt.
  profile.lastUsedAt = new Date().toISOString()
  await saveProfile(profile)

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
