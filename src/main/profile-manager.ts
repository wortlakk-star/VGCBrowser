// ── VGC Browser — profile manager ────────────────────────────────────────────
// Owns the runtime lifecycle of profiles: spawning an isolated Chromium per
// profile and tracking which are running. Each profile gets its own
// --user-data-dir (fully isolated cookies/cache/storage) and proxy.
//
// Phase 0 scope:
//   ✓ isolated user-data-dir per profile
//   ✓ per-profile proxy (no-auth)
//   ✓ UA / window-size / language passed as launch flags
//   ✓ remote-debugging-port reserved per profile (used by Phase 1 + automation)
// Not yet (later phases):
//   • CDP fingerprint injection (canvas/webgl/audio/webrtc) — Phase 1
//   • proxy authentication via local relay — Phase 3

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { app, BrowserWindow } from 'electron'
import type { Cookie, DataSyncState, ProfileRuntimeState } from '../shared/types'
import { ensureEngine, type EngineProgress } from './engine-download'
import { getProfile, saveProfile } from './store'
import { attachInjector, type InjectorHandle } from './cdp-injector'
import { startRelay, proxyNeedsRelay, type RelayHandle } from './proxy-relay'
import { seedFromString } from './fingerprint-script'
import { downloadProfileData, uploadProfileData } from './cloud-data'
import { getCloudSession } from './session'

interface RunningProfile {
  proc: ChildProcess
  state: ProfileRuntimeState
  injector?: InjectorHandle
  relay?: RelayHandle
}

/** Default fingerprint validation target opened by "Kiểm tra fingerprint". */
const DEFAULT_TEST_URL = 'https://abrahamjuliot.github.io/creepjs/'

const running = new Map<string, RunningProfile>()
let nextDebugPort = 9333

function profileDataDir(id: string): string {
  const dir = join(app.getPath('userData'), 'profiles', id)
  mkdirSync(dir, { recursive: true })
  return dir
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
    await uploadProfileData(id)
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
        broadcastData({ id, phase: 'done' })
      } catch {
        // best-effort — don't block quit on a single failure
      }
    })
  )
}

export async function launchProfile(
  id: string,
  opts: { headless?: boolean } = {}
): Promise<ProfileRuntimeState> {
  const existing = running.get(id)
  if (existing) return existing.state

  const profile = await getProfile(id)
  if (!profile) throw new Error(`Không tìm thấy profile: ${id}`)

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
  if (getCloudSession()) {
    try {
      broadcastData({ id, phase: 'download', message: 'Đang đồng bộ dữ liệu từ cloud…' })
      const got = await downloadProfileData(id)
      broadcastData({ id, phase: 'done', message: got ? 'Đã đồng bộ dữ liệu mới nhất' : undefined })
    } catch (err) {
      broadcastData({ id, phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const debugPort = nextDebugPort++
  const fp = profile.fingerprint

  const args: string[] = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    // Required by recent Chromium to allow our CDP WebSocket to connect.
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
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

  // Launch with a blank page so overrides are installed BEFORE any real
  // navigation; start URLs are opened via CDP once the injector is attached.
  args.push('about:blank')

  broadcast({ id, status: 'starting', debugPort })

  const proc = spawn(enginePath, args, { detached: false })

  const state: ProfileRuntimeState = {
    id,
    status: 'running',
    pid: proc.pid,
    debugPort,
    startedAt: new Date().toISOString()
  }
  const entry: RunningProfile = { proc, state, relay }
  running.set(id, entry)
  broadcast(state)

  // Touch lastUsedAt.
  profile.lastUsedAt = new Date().toISOString()
  await saveProfile(profile)

  proc.on('exit', () => {
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

  // Attach the fingerprint injector (UA/Client Hints/timezone/geo + JS stealth),
  // then open the profile's start URLs through it so they get the overrides.
  try {
    entry.injector = await attachInjector(profile, debugPort)
    for (const url of profile.startUrls) {
      await entry.injector.openUrl(url)
    }
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
