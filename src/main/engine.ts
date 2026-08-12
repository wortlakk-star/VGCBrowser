import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/** Locate only VGC Core binaries. Stock browsers ignore --vgc-* and are never returned. */
export function resolveEnginePath(): string | null {
  const dedicated = [
    join(app.getAppPath(), '..', 'engine', 'chromium', 'chrome.exe'),
    ...(!app.isPackaged ? [join(process.cwd(), 'engine', 'chromium', 'chrome.exe')] : []),
    join(app.getPath('userData'), 'engine', 'chromium', 'chrome.exe')
  ]
  return dedicated.find((candidate) => existsSync(candidate)) ?? null
}

export function isDedicatedEngine(path: string): boolean {
  return path.toLowerCase().includes(join('engine', 'chromium').toLowerCase())
}

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
