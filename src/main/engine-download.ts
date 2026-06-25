// ── VGC Browser — on-demand engine downloader ───────────────────────────────
// Like GoLogin fetching Orbita: the installer is light and does NOT bundle the
// ~hundreds-of-MB engine. On first launch we download the VGC Core engine .zip
// from the server (settings.engineUrl) into userData/engine/chromium and extract
// it. Subsequent launches use the local copy.

import { app } from 'electron'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import AdmZip from 'adm-zip'
import { getSettings } from './settings'
import {
  resolveEnginePath,
  isDedicatedEngine,
  macVgcCoreEngine,
  resolveSystemBrowser
} from './engine'
import type { EngineProgress } from '../shared/types'

export type { EngineProgress }

export function engineDir(): string {
  return join(app.getPath('userData'), 'engine', 'chromium')
}

export function downloadedEngineExe(): string {
  return join(engineDir(), 'chrome.exe')
}

export function isEngineInstalled(): boolean {
  return existsSync(downloadedEngineExe()) || Boolean(process.env.VGC_ENGINE_PATH)
}

/**
 * macOS: download + install the VGC Core engine zip (a built Chromium .app, made by
 * scripts/package-mac-engine.sh) into userData/engine/VGC Core.app, ad-hoc sign it,
 * and return its binary path. Returns null on any failure (→ fall back to Chrome).
 */
async function downloadMacEngine(
  url: string,
  onProgress?: (p: EngineProgress) => void
): Promise<string | null> {
  // Arch guard: the engine is a native Mach-O. Installing an arm64 build on an
  // Intel Mac (or vice-versa) yields a binary that can't launch AND permanently
  // shadows the working system-Chrome fallback (macVgcCoreEngine() would return
  // it on every later launch). Refuse the mismatched download → fall back to Chrome.
  const wantsArm = /arm64|aarch64/i.test(url)
  const wantsIntel = /x86_64|x64|intel/i.test(url)
  if ((wantsArm && process.arch !== 'arm64') || (wantsIntel && process.arch !== 'x64')) {
    return null
  }

  const dir = join(app.getPath('userData'), 'engine')
  await fs.mkdir(dir, { recursive: true })
  const zipPath = join(dir, 'vgc-core-mac.zip')

  onProgress?.({ phase: 'check', message: 'Chuẩn bị tải engine VGC Core…' })
  const res = await fetch(url)
  if (!res.ok || !res.body) return null
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  let lastPct = -1
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      if (total) {
        const pct = Math.round((received / total) * 100)
        if (pct !== lastPct) {
          lastPct = pct
          onProgress?.({ phase: 'download', percent: pct, message: `Đang tải engine ${pct}%` })
        }
      }
      cb(null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(zipPath)
  )

  onProgress?.({ phase: 'extract', message: 'Đang giải nén engine…' })
  const appPath = join(dir, 'VGC Core.app')
  try {
    // Remove any previous install first: `ditto -x -k` MERGES into an existing
    // bundle, so a stale framework/helper from an older build would be left behind
    // → a mixed-version, crash-on-launch .app. Replace it wholesale.
    await fs.rm(appPath, { recursive: true, force: true })
    // `ditto` preserves the .app bundle (symlinks + code signature) correctly.
    execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, dir])
  } finally {
    // Always clean up the downloaded zip, even if extraction threw.
    try {
      await fs.unlink(zipPath)
    } catch {
      // ignore
    }
  }
  if (!existsSync(join(appPath, 'Contents', 'MacOS', 'Chromium'))) return null
  if (existsSync(appPath)) {
    // Ad-hoc sign so Gatekeeper allows launch (best-effort; usually already signed).
    try {
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
    } catch {
      // ignore
    }
  }
  onProgress?.({ phase: 'done', percent: 100, message: 'Engine VGC Core sẵn sàng' })
  return macVgcCoreEngine()
}

/**
 * Returns a usable engine chrome.exe path, downloading VGC Core from the server
 * if it isn't installed yet. Falls back to a system browser only when no
 * engineUrl is configured (dev convenience).
 */
export async function ensureEngine(
  onProgress?: (p: EngineProgress) => void
): Promise<string> {
  // 1. Explicit override (e.g. local dev build).
  const override = process.env.VGC_ENGINE_PATH
  if (override && existsSync(override)) return override

  // 2. macOS: prefer the locally-built VGC Core engine (own Dock icon, isolated from
  //    the user's Chrome, CDP works) over the system Chrome.
  const macCore = macVgcCoreEngine()
  if (macCore) return macCore

  // 3. Engine BUNDLED with the installer (electron-builder win.extraResources →
  //    resources/engine/chromium), BRANDED with the VGC logo by brand-engine.mjs at
  //    build time. Preferred OVER any older runtime-downloaded engine in userData:
  //    that copy is the RAW unbranded zip, so using it would still show the stock
  //    Chromium logo on Windows even after the app updates. A fresh machine also
  //    gets the engine immediately here, with NO 341MB download.
  const resolved = resolveEnginePath()
  if (resolved && isDedicatedEngine(resolved)) return resolved

  // 4. A previously runtime-downloaded engine in userData (only reached when no
  //    bundled engine is present — an old install or a dev run).
  if (existsSync(downloadedEngineExe())) return downloadedEngineExe()

  // 4. macOS: download the native VGC Core engine (a built Chromium .app) if it's
  //    hosted (settings.engineUrlMac) and not yet installed; else fall back to the
  //    system Chrome. (Linux always uses the system browser.)
  if (process.platform === 'darwin') {
    const sMac = await getSettings()
    if (sMac.engineUrlMac) {
      const dl = await downloadMacEngine(sMac.engineUrlMac, onProgress).catch(() => null)
      if (dl) return dl
    }
  }
  if (process.platform !== 'win32') {
    if (resolved) return resolved // resolveEnginePath() already falls back to system Chrome/Edge
    throw new Error(
      'Không tìm thấy trình duyệt nền. Hãy cài Google Chrome trên máy này để VGC Browser dùng làm engine.'
    )
  }

  const s = await getSettings()

  // 3. No server configured → fall back to whatever's available (dev).
  if (!s.engineUrl) {
    const fallback = resolveEnginePath()
    if (fallback) return fallback
    throw new Error('Chưa cấu hình engineUrl và máy chưa có engine nào.')
  }

  // 4. Download + extract from the server.
  onProgress?.({ phase: 'check', message: 'Chuẩn bị tải engine…' })
  await fs.mkdir(engineDir(), { recursive: true })
  const zipPath = join(app.getPath('userData'), 'engine', 'vgc-core.zip')

  const res = await fetch(s.engineUrl)
  if (!res.ok || !res.body) throw new Error(`Tải engine lỗi: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)

  let received = 0
  let lastPct = -1
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      if (total) {
        const pct = Math.round((received / total) * 100)
        if (pct !== lastPct) {
          lastPct = pct
          onProgress?.({ phase: 'download', percent: pct, message: `Đang tải engine ${pct}%` })
        }
      }
      cb(null, chunk)
    }
  })

  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(zipPath)
  )

  onProgress?.({ phase: 'extract', message: 'Đang giải nén engine…' })
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(engineDir(), /* overwrite */ true)

  try {
    await fs.unlink(zipPath)
  } catch {
    // ignore
  }

  if (!existsSync(downloadedEngineExe())) {
    // Zip may have a top-level folder — find chrome.exe and note it.
    throw new Error('Giải nén xong nhưng không thấy chrome.exe (kiểm tra cấu trúc zip engine).')
  }

  onProgress?.({ phase: 'done', percent: 100, message: 'Engine sẵn sàng' })
  return downloadedEngineExe()
}
