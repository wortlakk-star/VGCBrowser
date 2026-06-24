// ── VGC Browser — engine locator ─────────────────────────────────────────────
// Finds the Chromium binary to launch profiles with. Resolution order:
//   1. VGC_ENGINE_PATH env override (explicit)
//   2. bundled/downloaded engine  → engine/chromium/chrome.exe  (our "VGC Core")
//   3. system Chrome / Edge / Brave / Chromium  (fallback so the launch loop works
//      even when the dedicated engine is missing OR can't be spawned, e.g. an
//      unsigned engine.exe quarantined by antivirus on Windows)
// Returns null if nothing is found.

import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// System-installed browsers usable as the engine / a fallback, in priority order.
const SYSTEM_BROWSERS = [
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // macOS (used as the engine on Mac builds)
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge'
]

/** Per-user Windows Chrome install (Chrome installed without admin lands here). */
function userInstalledWindowsChrome(): string | null {
  const local = process.env.LOCALAPPDATA
  if (!local) return null
  return join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
}

/**
 * Find a system-installed browser to use as the engine, optionally excluding one
 * path (so a failed dedicated engine isn't picked again). Returns null if none.
 */
export function resolveSystemBrowser(exclude?: string): string | null {
  for (const candidate of SYSTEM_BROWSERS) {
    if (candidate === exclude) continue
    if (existsSync(candidate)) return candidate
  }
  const userChrome = userInstalledWindowsChrome()
  if (userChrome && userChrome !== exclude && existsSync(userChrome)) return userChrome
  return null
}

export function resolveEnginePath(): string | null {
  const override = process.env.VGC_ENGINE_PATH
  if (override && existsSync(override)) return override

  const dedicated = [
    // bundled, relative to packaged app — BRANDED with the VGC logo by brand-engine.mjs
    // at build time. Must come BEFORE the userData copy: that copy is the RAW unbranded
    // runtime download, so returning it first kept the stock Chromium icon on machines
    // that had downloaded it under an older version. (The dff8502 fix reordered
    // ensureEngine() but delegated here, where userData was still first — so it never
    // actually took effect. This is the real fix.)
    join(app.getAppPath(), '..', 'engine', 'chromium', 'chrome.exe'),
    // bundled, relative to project root during dev
    join(process.cwd(), 'engine', 'chromium', 'chrome.exe'),
    // downloaded on-demand engine (userData) — UNBRANDED. Only used as a last resort
    // when no bundled engine exists (an old install or a dev run without a local engine).
    join(app.getPath('userData'), 'engine', 'chromium', 'chrome.exe')
  ]
  for (const candidate of dedicated) {
    if (existsSync(candidate)) return candidate
  }

  return resolveSystemBrowser()
}

/** True when the resolved engine is our own/ungoogled build (not a dev fallback). */
export function isDedicatedEngine(path: string): boolean {
  return path.toLowerCase().includes(join('engine', 'chromium').toLowerCase())
}

/**
 * macOS: the locally-installed VGC Core engine — a separately-BUILT Chromium (bundle
 * id org.chromium.Chromium, VGC-branded) at userData/engine/VGC Core.app. Preferred
 * over the system Chrome on Mac because it's a distinct browser (own Dock icon, not
 * mixed with the user's Chrome) AND its CDP works (cloning the system Chrome doesn't —
 * the clone relaunches to /Applications and loses --remote-debugging-port).
 * Returns the binary path, or null when not installed / non-mac.
 */
export function macVgcCoreEngine(): string | null {
  if (process.platform !== 'darwin') return null
  const bin = join(
    app.getPath('userData'),
    'engine',
    'VGC Core.app',
    'Contents',
    'MacOS',
    'Chromium'
  )
  return existsSync(bin) ? bin : null
}
