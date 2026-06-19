// ── VGC Browser — on-demand engine downloader ───────────────────────────────
// Like GoLogin fetching Orbita: the installer is light and does NOT bundle the
// ~hundreds-of-MB engine. On first launch we download the VGC Core engine .zip
// from the server (settings.engineUrl) into userData/engine/chromium and extract
// it. Subsequent launches use the local copy.

import { app } from 'electron'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import AdmZip from 'adm-zip'
import { getSettings } from './settings'
import { resolveEnginePath, isDedicatedEngine, macVgcCoreEngine } from './engine'
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
 * Returns a usable engine chrome.exe path, downloading VGC Core from the server
 * if it isn't installed yet. Falls back to a system browser only when no
 * engineUrl is configured (dev convenience).
 */
export async function ensureEngine(
  onProgress?: (p: EngineProgress) => void
): Promise<string> {
  // 1. Already downloaded locally (runtime download from a previous launch).
  if (existsSync(downloadedEngineExe())) return downloadedEngineExe()

  // 2. Explicit override (e.g. local dev build).
  const override = process.env.VGC_ENGINE_PATH
  if (override && existsSync(override)) return override

  // 2b. macOS: prefer the locally-built VGC Core engine (own Dock icon, isolated from
  //     the user's Chrome, CDP works) over the system Chrome.
  const macCore = macVgcCoreEngine()
  if (macCore) return macCore

  // 3. Engine BUNDLED with the installer (electron-builder win.extraResources →
  //    resources/engine/chromium). A fresh machine then has the antidetect engine
  //    immediately, with NO 341MB download. resolveEnginePath() finds it as a
  //    dedicated engine (vs a system-browser fallback).
  const resolved = resolveEnginePath()
  if (resolved && isDedicatedEngine(resolved)) return resolved

  // 4. Non-Windows (macOS/Linux): the downloadable VGC Core engine is Windows-only,
  // so use a system Chromium as the engine (CDP fingerprint injection still applies).
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
