// ── VGC Browser — build-time engine fetcher ──────────────────────────────────
// Downloads the VGC Core engine (the antidetect Chromium) into engine/chromium so
// it can be BUNDLED into the Windows installer (electron-builder win.extraResources
// → resources/engine/chromium). Run automatically by `npm run dist`, or manually:
//
//     npm run fetch-engine
//
// Skips the download if engine/chromium/chrome.exe is already present, so repeated
// builds don't re-fetch the ~341MB archive. Override the source with VGC_ENGINE_URL.
//
// NOTE: the engine is a Windows x64 build (chrome.exe + DLLs) → it is only meaningful
// for the Windows installer. The macOS build uses the system Google Chrome instead.

import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import AdmZip from 'adm-zip'

// Keep in sync with the default `engineUrl` in src/main/settings.ts.
const ENGINE_URL = process.env.VGC_ENGINE_URL || 'https://vgcbrowser.com/dl/vgc-core-155.zip'

const root = process.cwd()
const engineDir = join(root, 'engine')
const outDir = join(engineDir, 'chromium')
const exe = join(outDir, 'chrome.exe')
const zipPath = join(engineDir, 'vgc-core.zip')

if (existsSync(exe)) {
  console.log('✓ Engine đã có sẵn tại engine/chromium/chrome.exe — bỏ qua tải.')
  process.exit(0)
}

mkdirSync(engineDir, { recursive: true })

console.log(`→ Đang tải engine: ${ENGINE_URL}`)
const res = await fetch(ENGINE_URL)
if (!res.ok || !res.body) {
  console.error(`✗ Tải engine lỗi: HTTP ${res.status}`)
  process.exit(1)
}
const total = Number(res.headers.get('content-length') || 0)
let received = 0
let lastPct = -1
const counter = new Transform({
  transform(chunk, _enc, cb) {
    received += chunk.length
    if (total) {
      const pct = Math.round((received / total) * 100)
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct
        process.stdout.write(`\r  ${pct}% (${(received / 1048576).toFixed(0)}MB)   `)
      }
    }
    cb(null, chunk)
  }
})
await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(zipPath))
process.stdout.write('\n')

console.log('→ Giải nén vào engine/chromium …')
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
new AdmZip(zipPath).extractAllTo(outDir, /* overwrite */ true)
rmSync(zipPath, { force: true })

if (!existsSync(exe)) {
  console.error('✗ Giải nén xong nhưng không thấy chrome.exe — kiểm tra cấu trúc zip engine.')
  process.exit(1)
}
console.log('✓ Engine sẵn sàng tại engine/chromium/chrome.exe — sẽ được bundle vào installer Windows.')
