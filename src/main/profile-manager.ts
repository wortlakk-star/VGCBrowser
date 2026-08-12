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
import { randomBytes } from 'crypto'
import type { Readable, Writable } from 'node:stream'
import { isAbsolute, join } from 'path'
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fs
} from 'fs'
import { app, BrowserWindow } from 'electron'
import type { Cookie, DataSyncState, Fingerprint, ProfileRuntimeState } from '../shared/types'
import { ensureEngine, type EngineProgress } from './engine-download'
import { checkProxy, directGeo } from './proxy-check'
import { getProfile, patchProfile, listProfiles } from './store'
import { getSettings } from './settings'
import { attachInjector, type InjectorHandle } from './cdp-injector'
import { CdpConnection } from './cdp'
import { startRelay, proxyNeedsRelay, type RelayHandle } from './proxy-relay'
import { seedFromString } from './fingerprint-script'
import {
  downloadProfileData,
  uploadProfileData,
  downloadProfileCookies,
  uploadProfileCookiesDb,
  downloadProfileCookiesDb,
  uploadProfilePasswords,
  downloadProfilePasswords,
  ensureSafeProfileDestination
} from './cloud-data'
import {
  exportCookies,
  importCookies,
  exportLogins,
  importLogins
} from './password-bridge'
import { dbg } from './dbg'
import { validateBundledHiExtension } from './bundled-hi-extension'
import { ensureNativeGuardExtension } from './webrtc-guard'
import { getCloudSession, getCloudEmail } from './session'
import { refreshLicense, isLicensed, licenseState } from './license'
import { cohereFingerprint, hostOs, sanitizeStartUrls } from './profiles-service'
import { requireProfileId } from './validation'
import { accountTransitionInProgress, runAccountOperation } from './account-operations'

export interface LaunchProfileOptions {
  headless?: boolean
  cleanLogin?: boolean
  automation?: boolean
  /** Tile the window at this position/size (for "mở lưới"). Overrides the default window-size. */
  window?: { x: number; y: number; w: number; h: number }
}

interface RunningProfile {
  proc: ChildProcess
  state: ProfileRuntimeState
  accountUid: string | null
  injector?: InjectorHandle
  relay?: RelayHandle
  /** Control CDP connection for automation mode (bulk Gmail tool) — over the pipe. */
  automationConn?: CdpConnection
  /** Interval that polls + persists open tabs for cross-machine tab sync. */
  tabPoll?: ReturnType<typeof setInterval>
}

/** Default fingerprint validation target opened by "Kiểm tra fingerprint". */
const DEFAULT_TEST_URL = 'https://abrahamjuliot.github.io/creepjs/'

const running = new Map<string, RunningProfile>()

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The automation control connection for a running profile (bulk Gmail tool). */
export function getAutomationConn(id: string): CdpConnection | null {
  return running.get(id)?.automationConn ?? null
}

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

// NOTE: the old `cryptSecretFor()` (which derived a --vgc-crypt-secret value) was
// DELETED on 2026-07-13. Passing that switch made the engine seal cookies with a
// portable key and DROP every pre-existing machine-key cookie → logout on reopen
// (see the launchProfile comment + memory password-bridge-mac-stock-chrome). The
// engine now always uses its stable per-machine key; do NOT reintroduce the switch.

function profileDataDir(id: string): string {
  const profiles = join(app.getPath('userData'), 'profiles')
  const dir = join(profiles, requireProfileId(id))
  for (const path of [profiles, dir]) {
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Thư mục profile không an toàn.')
    }
    try {
      chmodSync(path, 0o700)
    } catch {
      // Windows relies on the current-user ACL.
    }
  }
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
  let handle: fs.FileHandle | undefined
  try {
    const file = openTabsFile(id)
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) {
      return []
    }
    const raw = await handle.readFile({ encoding: 'utf8' })
    const arr = JSON.parse(raw)
    return sanitizeStartUrls(arr)
  } catch {
    return [] // no saved tabs yet (first open) or unreadable
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeSavedTabs(id: string, urls: string[]): Promise<void> {
  let temp = ''
  try {
    const root = profileDataDir(id)
    const dir = join(root, 'Default')
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const dirStat = lstatSync(dir)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return
    const file = join(dir, 'vgc-open-tabs.json')
    temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    await fs.writeFile(temp, JSON.stringify(sanitizeStartUrls(urls)), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fs.rename(temp, file)
  } catch {
    // best-effort — tab sync must never break a launch
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {})
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
let accountTransitioning = false

function currentAccountUid(): string | null {
  return getCloudSession()?.uid ?? null
}

function sameAccount(uid: string | null): boolean {
  return currentAccountUid() === uid
}

/**
 * Cross-machine SAVED PASSWORDS + COOKIES bridge (previously UNWIRED — "future task").
 * On close: DECRYPT the profile's Login Data + Cookies with THIS machine's os_crypt key
 * (password-bridge.ts reads the machine DPAPI/keychain key, NOT the portable one) and
 * upload them account-secret-encrypted. On open: download + RE-ENCRYPT with the opening
 * machine's key + merge (insert/update, never delete). This is what keeps a Gmail signed
 * in on machine A signed in on machine B (before, B had to sign in again). Fully
 * best-effort: any failure is a no-op — the bridge never deletes and writes the DB
 * atomically, so it can never corrupt or downgrade the live session.
 */
async function uploadCredentials(id: string, expectedUid = currentAccountUid()): Promise<void> {
  try {
    if (!expectedUid || !sameAccount(expectedUid)) return
    const dir = profileDataDir(id)
    const [cookies, logins] = await Promise.all([
      exportCookies(dir, id).catch(() => []),
      exportLogins(dir, id).catch(() => [])
    ])
    if (!sameAccount(expectedUid)) return
    await Promise.allSettled([
      cookies.length ? uploadProfileCookiesDb(id, cookies) : Promise.resolve(),
      logins.length ? uploadProfilePasswords(id, logins) : Promise.resolve()
    ])
    if (cookies.length || logins.length)
      dbg(`[creds ${id}] uploaded ${cookies.length} cookies + ${logins.length} logins`)
  } catch {
    /* best-effort — never block close */
  }
}

async function downloadCredentials(id: string, expectedUid = currentAccountUid()): Promise<void> {
  try {
    if (!expectedUid || !sameAccount(expectedUid)) return
    const dir = profileDataDir(id)
    const [cookies, logins] = await Promise.all([
      downloadProfileCookiesDb(id).catch(() => []),
      downloadProfilePasswords(id).catch(() => [])
    ])
    if (!sameAccount(expectedUid)) return
    if (cookies.length) await importCookies(dir, id, cookies).catch(() => 0)
    if (logins.length) await importLogins(dir, id, logins).catch(() => 0)
    if (cookies.length || logins.length)
      dbg(`[creds ${id}] imported ${cookies.length} cookies + ${logins.length} logins`)
  } catch {
    /* best-effort — never block open */
  }
}

/** When a single profile closes (app stays open): auto-upload its session. */
async function syncDataOnClose(id: string, expectedUid: string | null): Promise<void> {
  try {
    if (isQuitting || accountTransitioning) return
    if (!expectedUid || !sameAccount(expectedUid)) return
    // Hold the per-profile lock for the WHOLE flush+upload, and take it BEFORE the
    // flush-grace sleep. Otherwise a reopen within ~1.2s takes the lock first,
    // downloads a stale cloud snapshot over the freshest local dir, and this delayed
    // upload then zips the just-relaunched (mid-write) profile → corrupt/downgraded
    // session propagates to every machine. Holding the lock makes a reopen wait.
    await withDataLock(id, async () => {
      // small grace so Chromium finishes flushing Cookies/Login Data SQLite files
      await new Promise((r) => setTimeout(r, 1200))
      if (!sameAccount(expectedUid)) return
      broadcastData({ id, phase: 'upload', message: 'Đang lưu phiên lên cloud…' })
      // Uploads Local Storage / IndexedDB / Preferences etc. — NOT Cookies/Login Data
      // (excluded via SKIP_FILES; those stay per-machine so the session never churns).
      await uploadProfileData(id)
      // Cross-machine cookies + saved passwords (decrypt-locally → cloud → re-encrypt on B).
      await uploadCredentials(id, expectedUid)
      dbg(`[close ${id}] uploaded zip + credentials bridge`)
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
async function stopRunningAndSync(quitting: boolean): Promise<void> {
  if (quitting) isQuitting = true
  accountTransitioning = true
  const expectedUid = currentAccountUid()
  const ids = new Set<string>()
  try {
    const stopDeadline = Date.now() + 10_000
    while (running.size > 0 && Date.now() < stopDeadline) {
      for (const [id, entry] of running) {
        if (entry.accountUid === expectedUid) ids.add(id)
        stopProfile(id)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (running.size > 0) {
      for (const [id, entry] of running) {
        if (entry.accountUid === expectedUid) ids.add(id)
        try {
          entry.proc.kill('SIGKILL')
        } catch {
          // checked below
        }
      }
      const forceDeadline = Date.now() + 2_000
      while (running.size > 0 && Date.now() < forceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (running.size > 0 && !quitting) {
      throw new Error('Không thể dừng hết profile; chưa chuyển tài khoản để tránh lẫn dữ liệu.')
    }
    if (!expectedUid || !sameAccount(expectedUid) || ids.size === 0) return
    await new Promise((resolve) => setTimeout(resolve, 300))
    await Promise.allSettled(
      [...ids].map(async (id) => {
        if (!sameAccount(expectedUid)) return
        try {
          broadcastData({
            id,
            phase: 'upload',
            message: quitting
              ? 'Đang lưu phiên lên cloud trước khi thoát…'
              : 'Đang lưu phiên trước khi đổi tài khoản…'
          })
          await withDataLock(id, async () => {
            if (!sameAccount(expectedUid)) return
            await uploadProfileData(id)
            await uploadCredentials(id, expectedUid)
          })
          broadcastData({ id, phase: 'done' })
        } catch {
          // One failed profile must not cross-contaminate or block the others.
        }
      })
    )
  } finally {
    if (!quitting) accountTransitioning = false
  }
}

export function stopAllAndSync(): Promise<void> {
  return stopRunningAndSync(true)
}

export function stopAllForAccountSwitch(): Promise<void> {
  return stopRunningAndSync(false)
}

/**
 * Batch: for every profile that has a proxy, look up the proxy's exit-IP timezone,
 * geolocation and PERSIST them onto the profile's fingerprint — so each
 * profile's clock/location matches the country its proxy exits from (a Vietnam clock
 * behind a US proxy is a classic anti-bot tell). Runs the proxy checks with limited
 * concurrency. Returns how many were aligned.
 */
export async function syncTimezonesToProxies(): Promise<{
  synced: number
  total: number
  failed: number
}> {
  const profiles = await listProfiles()
  const targets = profiles.filter(
    (p) => p.proxy && p.proxy.type !== 'none' && p.proxy.host && p.proxy.port
  )
  let synced = 0
  let failed = 0
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < targets.length) {
      const p = targets[i++]
      try {
        const geo = await Promise.race([
          checkProxy(p.proxy),
          new Promise<null>((r) => setTimeout(() => r(null), 8000))
        ])
        if (geo && geo.ok && geo.timezone) {
          const fpNext: Fingerprint = {
            ...p.fingerprint,
            timezone: geo.timezone,
            geolocation:
              typeof geo.latitude === 'number' && typeof geo.longitude === 'number'
                ? { latitude: geo.latitude, longitude: geo.longitude, accuracy: 100 }
                : p.fingerprint.geolocation
          }
          await patchProfile(p.id, { fingerprint: fpNext })
          synced++
        } else {
          failed++
        }
      } catch {
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, targets.length) }, () => worker()))
  return { synced, total: targets.length, failed }
}

/**
 * Spawn the engine and resolve only once it has actually started (the child's
 * 'spawn' event). Rejects on failure — INCLUDING async failures: on Windows a
 * CreateProcess error like `spawn UNKNOWN` (engine blocked by antivirus / locked /
 * corrupt) is emitted on the 'error' event AFTER spawn() returns, so a plain
 * try/catch around spawn() never sees it. Waiting on the events catches both the
 * sync throw and the async 'error', so the UI receives an actionable engine error.
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

async function launchProfileImpl(
  id: string,
  opts: LaunchProfileOptions = {}
): Promise<ProfileRuntimeState> {
  if (isQuitting || accountTransitioning || accountTransitionInProgress()) {
    throw new Error('Ứng dụng đang dừng profile hoặc chuyển tài khoản.')
  }
  const launchAccountUid = currentAccountUid()
  requireProfileId(id)
  const existing = running.get(id)
  if (existing) {
    // Automation mode needs a control pipe. If this profile is already open but WITHOUT
    // one (a normal user launch), force it closed and relaunch so we get the pipe —
    // otherwise return the live state as usual.
    if (opts.automation && !existing.automationConn) {
      try {
        existing.proc.kill()
      } catch {
        // ignore
      }
      const until = Date.now() + 10000
      while (running.has(id) && Date.now() < until) await sleepMs(200)
      if (running.has(id)) {
        try {
          existing.proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        while (running.has(id) && Date.now() < until + 3000) await sleepMs(200)
      }
      if (running.has(id)) throw new Error('Không đóng được profile đang mở để chạy tự động')
    } else {
      return existing.state
    }
  }

  const profile = await getProfile(id)
  if (!sameAccount(launchAccountUid) || accountTransitioning || accountTransitionInProgress()) {
    throw new Error('Tài khoản đã thay đổi trong lúc mở profile.')
  }
  if (!profile) throw new Error(`Không tìm thấy profile: ${id}`)
  if (profile.os !== hostOs()) {
    throw new Error(
      `Profile ${profile.os} không tương thích host ${hostOs()}. Hãy tạo fingerprint cùng hệ điều hành máy.`
    )
  }

  // ── Access gate: only emails the admin approved (vgcbrowser.com/quanly) may open a
  // profile. Re-checked here so a revoke takes effect on the next open. Network blip →
  // falls back to the last-known cached decision (see license.ts), so it never locks out
  // an already-approved user; a never-approved / signed-out email stays blocked.
  await refreshLicense(getCloudEmail())
  if (!isLicensed()) {
    const st = licenseState()
    const msg = st.email
      ? `Tài khoản "${st.email}" chưa được cấp phép dùng VGC Browser. Liên hệ admin để kích hoạt.`
      : 'Vui lòng ĐĂNG NHẬP bằng tài khoản đã được admin cấp phép để mở profile.'
    broadcast({ id, status: 'error', error: msg })
    throw new Error(msg)
  }

  // GoLogin model: open with the engine's NATIVE C++ fingerprint spoofing and DO NOT
  // attach a CDP debugger — Google blocks browsers with an active CDP session at
  // sign-in, so this is what makes Google login work. nativeMode is ON by default;
  // the "Đăng nhập Google" button (opts.cleanLogin) always skips CDP too. The headless
  // automation API path keeps CDP (it has no human signing into Google).
  const settings = await getSettings()
  // Automation mode (bulk tools like "đổi mật khẩu Gmail"): keep the NATIVE engine
  // fingerprint but expose a real CDP debug PORT we drive from our own minimal control
  // connection (Runtime.evaluate + Input only, NO Runtime.enable → low automation
  // footprint, navigator.webdriver stays false). We do NOT attach the fingerprint
  // injector here (skipCdp = true) — the native engine already spoofs everything in
  // C++, and a second CDP client would be redundant. The session is preserved so a
  // profile that's already signed into Google stays signed in.
  const automation = opts.automation === true
  const skipCdp = automation || (!opts.headless && (opts.cleanLogin === true || settings.nativeMode !== false))
  const cleanLogin = opts.cleanLogin === true
  // A CDP pipe is spawned when the injector attaches (CDP mode) OR for automation control.
  const usePipe = !skipCdp || automation

  let enginePath: string
  try {
    enginePath = await ensureEngine((p) => broadcastEngine(id, p))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    broadcast({ id, status: 'error', error: msg })
    throw new Error(msg)
  }

  const userDataDir = await ensureSafeProfileDestination(id)

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
      // SESSION STORES (Cookies / Login Data / Local State) are kept PURELY LOCAL —
      // they're sealed with a per-machine key, so the cross-machine bridge is disabled
      // here (it churned the session). downloadProfileData preserves the local copies.
      const got = await withDataLock(id, () => downloadProfileData(id))
      // Cross-machine cookies + saved passwords: download + re-encrypt with THIS machine's
      // key BEFORE launch (browser not running yet, so mutating the DB is safe).
      await withDataLock(id, () => downloadCredentials(id))
      dbg(`[open ${id}] downloaded=${got} + credentials bridge`)
      // Legacy CDP cookie seed — only used in CDP mode; native mode ignores it.
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

  // ── Fingerprint coherence: align timezone / geolocation / WebRTC IP to
  // the proxy's EXIT IP so they can't contradict each other. A US proxy reporting a
  // Vietnam timezone (or leaking the real public IP via WebRTC) is a classic bot
  // tell. Looked up live so it works with rotating residential proxies; capped at
  // 6s and falls back to the profile's stored fingerprint so launch never hangs.
  let fp: Fingerprint = cohereFingerprint(profile.fingerprint)
  const hasProxyForGeo =
    !!profile.proxy && profile.proxy.type !== 'none' && !!profile.proxy.host && !!profile.proxy.port
  // Align timezone/geo to the EXIT IP — the proxy's when there is one, otherwise the
  // machine's REAL public IP. A no-proxy profile that keeps a random stored timezone
  // (e.g. Europe/Paris) while the real IP is elsewhere (e.g. Vietnam) is incoherent and
  // makes Cloudflare Turnstile fail to load (error 600010). Either way, IP ⇄ timezone ⇄
  // reported location must agree. Language remains the host locale; a user can use any
  // language in any country, while changing it with rotating proxies is unstable.
  {
    try {
      broadcastData({
        id,
        phase: 'download',
        message: hasProxyForGeo ? 'Đang khớp múi giờ/vị trí theo proxy…' : 'Đang khớp múi giờ theo IP thật…'
      })
      const geo = await Promise.race([
        hasProxyForGeo ? checkProxy(profile.proxy) : directGeo(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000))
      ])
      if (geo && geo.ok) {
        const next: Fingerprint = { ...fp }
        if (geo.timezone) next.timezone = geo.timezone
        if (geo.ip) next.webrtcPublicIp = geo.ip
        if (typeof geo.latitude === 'number' && typeof geo.longitude === 'number') {
          next.geolocation = { latitude: geo.latitude, longitude: geo.longitude, accuracy: 100 }
        }
        fp = next
      }
      broadcastData({ id, phase: 'done' })
    } catch {
      // keep the profile's stored fingerprint — coherence is best-effort
    }
  }
  // Persist host-coherent hardware/locale plus proxy timezone/geolocation. The
  // current proxy exit IP is intentionally ephemeral and is not written to disk.
  const { webrtcPublicIp: _ephemeralIp, ...stableFp } = fp
  if (JSON.stringify(stableFp) !== JSON.stringify(profile.fingerprint)) {
    await patchProfile(id, { fingerprint: stableFp as Fingerprint }).catch(() => {})
  }

  const defaultWindow = opts.headless
    ? `${fp.screen.width},${Math.max(480, fp.screen.height - 40)}`
    : `${Math.min(1280, fp.screen.width)},${Math.min(900, Math.max(480, fp.screen.height - 80))}`

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
    `--accept-lang=${(fp.languages && fp.languages.length ? fp.languages : [fp.language]).join(',')}`,
    // Default window must not exceed the reported WORK AREA. The screen spoof reports
    // availHeight = screen.height - 40 (the taskbar inset in VGC Core), so opening
    // at the FULL screen height made outerHeight >
    // screen.availHeight — impossible on a real machine with a taskbar, a first-class
    // creepjs/pixelscan tell. Cap the height to availHeight (a maximized-but-coherent
    // window). Grid mode already passes an explicit, bounded slot size.
    `--window-size=${opts.window ? `${opts.window.w},${opts.window.h}` : defaultWindow}`,
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
    // navigator.languages stays aligned with the host locale and request headers. This is
    // native because --lang alone is a no-op for navigator.languages on macOS.
    `--vgc-accept-languages=${(fp.languages && fp.languages.length ? fp.languages : [fp.language]).join(',')}`,
    // Per-profile FONT allowlist → engine (font_cache.cc) hides every system font NOT in
    // this list, so the width-probe / measureText / canvas / FontFaceSet.check all report
    // a per-profile font set. Without this every profile on one machine enumerated the
    // IDENTICAL real Windows font set — a high-entropy same-machine correlator Google uses
    // to link "different" profiles. fp.fonts is a per-profile subset of the real fonts.
    ...(fp.fonts && fp.fonts.length ? [`--vgc-fonts=${fp.fonts.join(',')}`] : []),
    // Headful profiles use the host's real screen/DPR model. Headless has no physical
    // display surface, so keep its native media queries aligned with the same profile.
    ...(opts.headless
      ? [
          `--vgc-screen=${fp.screen.width}x${fp.screen.height}`,
          `--vgc-color-depth=${fp.screen.colorDepth}`,
          `--force-device-scale-factor=${fp.devicePixelRatio}`
        ]
      : []),
    // Unique per-profile seed → engine seeds canvas/audio/client-rects/connection noise.
    `--vgc-seed=${seedFromString(id)}`,
    // Profile name shown in the OS window title (title bar / Cmd-Tab / Dock) so you
    // can tell which profile a window is — NOT in document.title, so it never leaks
    // to the page. GoLogin-style profile labelling.
    `--vgc-profile-name=${profile.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120)}`
  ]

  // ── os_crypt key: ALWAYS let the engine use its OWN per-machine key ──────────
  // ⚠️ PROVEN by a live engine test (2026-07-13, see memory password-bridge-mac-stock-
  // chrome): passing --vgc-crypt-secret makes the VGC Core engine seal cookies with a
  // PORTABLE key and DROP every pre-existing machine-key cookie it can no longer decrypt.
  // Measured: a profile with 216 healthy machine-key cookies collapsed to 82 (Google +
  // PayPal among the 134 destroyed) after ONE open with the switch — this is exactly the
  // "thoát ra là mất cookie, phải đăng nhập lại" bug. WITHOUT the switch the same profile
  // kept all 217 cookies across a real close/reopen, every one still machine-key-decryptable.
  // So we NEVER pass the switch: the engine keeps its stable machine key, the on-disk
  // session always decrypts, and same-machine login persists indefinitely. Cross-machine
  // cookies + saved passwords now travel via the WIRED bridge (uploadCredentials /
  // downloadCredentials above): they are decrypted with THIS machine's key, stored
  // account-secret-encrypted in the cloud, and re-encrypted with the other machine's key on
  // open — WITHOUT a shared engine key (which is what destroyed cookies in 2.1.11–2.1.14).
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.VGC_CRYPT_SECRET
  // HARDENING: childEnv inherits the whole host environment. If this machine ever has
  // GOOGLE_DEFAULT_CLIENT_ID / _SECRET set globally (a stray setx, a dev shell, CI), they
  // would reach the engine and re-trigger the DICE AccountReconcilor that deletes the
  // .google.com session on reopen (the v2.1.16 regression). Not setting them is not enough
  // — we must actively STRIP them so their absence is guaranteed regardless of host env.
  delete childEnv.GOOGLE_DEFAULT_CLIENT_ID
  delete childEnv.GOOGLE_DEFAULT_CLIENT_SECRET
  dbg(`[launch ${id}] NO crypt switch (engine keeps machine key) cloudSession=${!!getCloudSession()}`)
  // Kill Chromium's yellow "Google API keys are missing" infobar that shows on EVERY
  // page — it's clutter AND an antidetect tell (real Chrome never shows it). Chromium
  // reads these keys from the environment at runtime; any non-default value makes
  // HasAPIKeyConfigured() true so the bar never appears. They're NOT used for login
  // (profiles sign in via the web) and are never exposed to web pages.
  childEnv.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'no-key'
  // ⚠️ DO NOT set GOOGLE_DEFAULT_CLIENT_ID / GOOGLE_DEFAULT_CLIENT_SECRET here.
  // The infobar is gated ONLY on the API key (engine infobar_utils.cc:188:
  // `if (!google_apis::HasAPIKeyConfigured())`), so GOOGLE_API_KEY alone kills it.
  // Configuring an OAuth *client* (id+secret) makes the engine's
  // google_apis::HasOAuthClientConfigured() return true, which flips desktop Account
  // Consistency from Disabled to DICE (account_consistency_mode_manager.cc:
  // CanEnableDiceForBuild → IsDiceSignInAllowed → ComputeAccountConsistencyMethod → kDice).
  // DICE turns on the AccountReconcilor, which on every cold start reconciles the
  // content-area .google.com cookies against Chrome's token service. With these garbage
  // creds the OAuth/multilogin exchange fails and the reconcilor DELETES the GAIA account
  // cookie cluster (SID/HSID/SSID/APISID/SAPISID/__Secure-*PSID/__Secure-*PSIDTS/LSID) on
  // reopen — YouTube is out of accounts.google.com reconcile scope so it survives. This is
  // the "Google logs out on reopen" regression (2.x vs working 0.1.102, which never set
  // these → HasOAuthClientConfigured()=false → account consistency Disabled → web session
  // left untouched). Restoring the 0.1.102 input here is the fix; the crypt-secret
  // switch-removal above is orthogonal and stays.

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

  // Load the native privacy guard in every mode. WebRTC policy and geolocation denial are
  // browser settings, not page-level shims, so CDP pages and workers receive the same policy.
  const guardFp: Fingerprint = { ...fp, webrtc: hasProxy ? 'proxy' : 'real' }
  const guardExt = ensureNativeGuardExtension(userDataDir, guardFp)
  // HI is shipped with the app and loaded into every profile. Its files are verified before
  // launch because this extension can read/write cookies when the user opens its popup.
  const hiRoot = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'HI')
    : join(app.getAppPath(), 'resources', 'extensions', 'HI')
  const hiExt = validateBundledHiExtension(hiRoot)
  const safeExtensions = (profile.extensions ?? []).filter((candidate) => {
    if (!isAbsolute(candidate) || candidate.includes(',') || candidate.includes('\0')) return false
    try {
      const dirStat = lstatSync(candidate)
      const manifestStat = lstatSync(join(candidate, 'manifest.json'))
      return (
        dirStat.isDirectory() &&
        !dirStat.isSymbolicLink() &&
        manifestStat.isFile() &&
        !manifestStat.isSymbolicLink() &&
        manifestStat.nlink === 1 &&
        manifestStat.size > 0 &&
        manifestStat.size <= 1024 * 1024
      )
    } catch {
      return false
    }
  })
  const extList = [guardExt, hiExt, ...safeExtensions]
  if (extList.length > 0) {
    const list = extList.join(',')
    args.push(`--load-extension=${list}`, `--disable-extensions-except=${list}`)
  }

  // Headless (used by the automation API).
  if (opts.headless) args.push('--headless=new')

  // Tile the window into a grid slot (opts.window from "Mở lưới").
  if (opts.window) args.push(`--window-position=${opts.window.x},${opts.window.y}`)

  // CDP over a PIPE — for the fingerprint injector (CDP mode) OR the automation control
  // connection (bulk Gmail tool). A PIPE (fds 3/4), NOT a TCP debug port: a port would
  // expose an unauthenticated DevTools endpoint any local process could attach to and
  // drive the browser while it holds a live Google session. Native user launches skip it.
  if (!skipCdp || automation) args.push('--remote-debugging-pipe')

  // Where to land. CDP mode opens about:blank (injector then reopens tabs). Native mode
  // has no injector, so open the profile's start URLs directly. Clean-login → Google.
  if (automation) {
    // Land on a BLANK page — never a Google form. Every automation caller (gmail-login,
    // gmail-password, rpa warm-up) navigates to its own target right after attaching, so a
    // real landing page only causes a race: e.g. the change-password form would load first
    // and the login brain (loginOnly) would see it as a forced new-password page and bail
    // WITHOUT ever signing in. about:blank has no form for the brain to misread.
    args.push('about:blank')
  } else if (cleanLogin) {
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
      const safeUrls = sanitizeStartUrls(profile.startUrls)
      const urls = safeUrls.length ? safeUrls : ['about:blank']
      args.push(...urls)
    }
  } else {
    args.push('about:blank')
  }

  broadcast({ id, status: 'starting' })

  // Spawn only the verified VGC Core engine. Falling back to stock Chrome would
  // keep the spoofed UA while exposing real CPU/GPU/screen values.
  if (!sameAccount(launchAccountUid) || accountTransitioning || accountTransitionInProgress()) {
    throw new Error('Tài khoản đã thay đổi trong lúc chuẩn bị engine.')
  }

  let proc: ChildProcess
  try {
    proc = await spawnAndWait(enginePath, args, usePipe, childEnv)
  } catch (err) {
    relay?.close()
    const msg = `Không mở được VGC Core đã xác minh: ${err instanceof Error ? err.message : String(err)}`
    broadcast({ id, status: 'error', error: msg })
    throw new Error(msg)
  }

  const state: ProfileRuntimeState = {
    id,
    status: 'running',
    pid: proc.pid,
    startedAt: new Date().toISOString()
  }
  const entry: RunningProfile = { proc, state, relay, accountUid: launchAccountUid }
  running.set(id, entry)
  broadcast(state)

  // Attach exit/error listeners IMMEDIATELY (before any await) so a process that dies
  // during the patchProfile await below is still cleaned up (never left in `running`).
  proc.on('exit', () => {
    if (entry.tabPoll) clearInterval(entry.tabPoll)
    entry.injector?.dispose()
    entry.automationConn?.close()
    entry.relay?.close()
    running.delete(id)
    lastCookieSnapshot.delete(id) // don't retain the profile's cookie snapshot after it closes
    broadcast({ id, status: 'stopped' })
    // GoLogin-style sync-on-close: push the freshest session back to the cloud.
    void runAccountOperation(() => syncDataOnClose(id, entry.accountUid)).catch(() => {})
  })
  proc.on('error', (err) => {
    // Mirror the 'exit' cleanup: the tabPoll interval would otherwise keep firing every 5s
    // forever against a dead CDP connection once the entry is removed from `running`.
    if (entry.tabPoll) clearInterval(entry.tabPoll)
    entry.injector?.dispose()
    entry.automationConn?.close()
    entry.relay?.close()
    running.delete(id)
    lastCookieSnapshot.delete(id)
    broadcast({ id, status: 'error', error: String(err) })
  })

  if (!sameAccount(launchAccountUid) || accountTransitioning || accountTransitionInProgress()) {
    try {
      proc.kill()
    } catch {
      // exit/error handlers perform cleanup
    }
    throw new Error('Tài khoản đã thay đổi trong lúc khởi chạy profile.')
  }

  // Touch lastUsedAt via an atomic patch (re-reads fresh inside the store lock) so a
  // profile edit made while this profile was opening — the cloud download can take
  // several seconds — isn't clobbered by writing back the pre-launch snapshot.
  await patchProfile(id, { lastUsedAt: new Date().toISOString() }).catch(() => {})

  // Automation mode: open our OWN control connection over the CDP pipe (the injector is
  // NOT attached — the native engine already spoofs the fingerprint). gmail-password.ts
  // drives it via getAutomationConn(id). Then return (no injector, no tab sync).
  if (automation) {
    try {
      entry.automationConn = CdpConnection.connectPipe(
        proc.stdio[3] as Writable,
        proc.stdio[4] as Readable
      )
    } catch (err) {
      broadcast({ id, status: 'error', error: `Không mở được kênh điều khiển: ${String(err)}` })
    }
    return state
  }

  // Native mode / clean login: NO CDP injector (that's the whole point — Google must
  // see an ordinary browser). The engine still spoofs the fingerprint natively (C++).
  // The session is saved to the profile dir and synced on close.
  if (skipCdp) return state

  // Attach the CDP controller (UA/Client Hints/timezone/geo, cookies and tabs),
  // then open the profile's start URLs through it so they get the overrides.
  try {
    const injector = await attachInjector(
      { ...profile, fingerprint: fp },
      { write: proc.stdio[3] as Writable, read: proc.stdio[4] as Readable },
      { seedCookies: syncedCookies }
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
    const savedTabs = sanitizeStartUrls(await readSavedTabs(id))
    const toOpen = savedTabs.length > 0 ? savedTabs : sanitizeStartUrls(profile.startUrls)
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

export function launchProfile(
  id: string,
  opts: LaunchProfileOptions = {}
): Promise<ProfileRuntimeState> {
  return runAccountOperation(() => launchProfileImpl(id, opts))
}

/**
 * Open a fingerprint test page inside the profile (launching it first if needed).
 */
export async function checkFingerprint(
  id: string,
  url: string = DEFAULT_TEST_URL
): Promise<void> {
  requireProfileId(id)
  const safeUrl = sanitizeStartUrls([url])[0] ?? DEFAULT_TEST_URL
  let entry = running.get(id)
  if (!entry) {
    await launchProfile(id)
    entry = running.get(id)
  }
  if (entry?.injector) {
    await entry.injector.openUrl(safeUrl)
  }
}

export function stopProfile(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return
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
  requireProfileId(id)
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
  requireProfileId(id)
  let entry = running.get(id)
  if (!entry) {
    await launchProfile(id)
    entry = running.get(id)
  }
  if (!entry?.injector) return
  for (const url of sanitizeStartUrls(urls).slice(0, 20)) {
    await entry.injector.openUrl(url)
    await new Promise((r) => setTimeout(r, 3000))
  }
}

/** Kill every running profile (called on app quit). */
export function stopAll(): void {
  for (const id of [...running.keys()]) stopProfile(id)
}
