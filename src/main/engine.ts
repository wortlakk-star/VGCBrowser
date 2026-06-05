// ── VGC Browser — engine locator ─────────────────────────────────────────────
// Finds the Chromium binary to launch profiles with. Resolution order:
//   1. VGC_ENGINE_PATH env override (explicit)
//   2. bundled engine  → engine/chromium/chrome.exe  (ungoogled-chromium for now,
//      replaced by our patched "VGC Core" build in Phase 5)
//   3. system Chrome / Edge  (dev fallback so the launch loop works before we
//      download an engine)
// Returns null if nothing is found.

import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export function resolveEnginePath(): string | null {
  const override = process.env.VGC_ENGINE_PATH
  if (override && existsSync(override)) return override

  const candidates = [
    // downloaded on-demand engine (userData)
    join(app.getPath('userData'), 'engine', 'chromium', 'chrome.exe'),
    // bundled, relative to packaged app
    join(app.getAppPath(), '..', 'engine', 'chromium', 'chrome.exe'),
    // bundled, relative to project root during dev
    join(process.cwd(), 'engine', 'chromium', 'chrome.exe'),
    // Windows system browsers
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS system browsers (used as the engine on Mac builds)
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux system browsers
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge'
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** True when the resolved engine is our own/ungoogled build (not a dev fallback). */
export function isDedicatedEngine(path: string): boolean {
  return path.toLowerCase().includes(join('engine', 'chromium').toLowerCase())
}
