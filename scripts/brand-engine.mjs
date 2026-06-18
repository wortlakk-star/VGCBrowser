// ── VGC Browser — brand the engine executables ───────────────────────────────
// Replaces the icon embedded in the bundled VGC Core engine (chrome.exe and
// chrome_proxy.exe) with the VGC logo, so a profile opened on Windows shows the
// VGC icon on the taskbar instead of the Chrome/Chromium icon.
//
// Runs automatically by `npm run dist` AFTER fetch-engine.mjs has populated
// engine/chromium/. Windows-only (rcedit edits PE resources). Best-effort: a
// failure just leaves the default icon — it never breaks the build.
//
// NOTE: this only changes the taskbar ICON. Renaming the window title / about page
// ("Chrome" → "VGC Browser") needs a Chromium build with custom branding (Phase 5).

import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  console.log('brand-engine: chỉ chạy trên Windows (rcedit) — bỏ qua.')
  process.exit(0)
}

const root = process.cwd()
const ico = join(root, 'resources', 'vgc.ico')
if (!existsSync(ico)) {
  console.warn('brand-engine: thiếu resources/vgc.ico — bỏ qua.')
  process.exit(0)
}

const engineDir = join(root, 'engine', 'chromium')
const targets = ['chrome.exe', 'chrome_proxy.exe']
  .map((n) => join(engineDir, n))
  .filter((p) => existsSync(p))

if (!targets.length) {
  console.warn('brand-engine: chưa thấy engine/chromium/chrome.exe — chạy fetch-engine trước. Bỏ qua.')
  process.exit(0)
}

let rcedit
try {
  rcedit = (await import('rcedit')).default
} catch {
  console.warn('brand-engine: chưa cài gói "rcedit" (npm i -D rcedit) — bỏ qua.')
  process.exit(0)
}

for (const exe of targets) {
  try {
    await rcedit(exe, { icon: ico })
    console.log('✓ Đã gắn logo VGC vào', exe)
  } catch (e) {
    console.warn('brand-engine: gắn icon lỗi cho', exe, '—', e.message, '(bỏ qua)')
  }
}
