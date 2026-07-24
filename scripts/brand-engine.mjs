// ── VGC Browser — brand the engine binaries ──────────────────────────────────
// Replaces the icon embedded in the bundled VGC Core engine with the VGC logo, so
// a profile opened on Windows shows the VGC icon instead of the Chromium one.
//
// chrome.dll IS REQUIRED HERE, not just the .exe. On Windows the whole browser UI
// lives in chrome.dll, and the browser window loads its icon (IDR_MAINFRAME) from
// THAT module — not from the running .exe. Branding only chrome.exe therefore fixed
// the icon Explorer shows for the file while the WINDOW and TASKBAR kept the stock
// blue Chromium logo, which is exactly what "the logo disappeared" looked like.
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
// chrome.dll first — it is the one that actually drives the window/taskbar icon.
const targets = ['chrome.dll', 'chrome.exe', 'chrome_proxy.exe']
  .map((n) => join(engineDir, n))
  .filter((p) => existsSync(p))

if (!targets.length) {
  console.warn('brand-engine: chưa thấy engine/chromium/chrome.exe — chạy fetch-engine trước. Bỏ qua.')
  process.exit(0)
}

// Branding chrome.exe alone is the bug this script previously shipped: the taskbar
// icon comes from chrome.dll. Fail loudly rather than silently ship a stock logo.
if (!targets.some((p) => p.endsWith('chrome.dll'))) {
  console.warn('brand-engine: KHÔNG thấy engine/chromium/chrome.dll — icon taskbar sẽ vẫn là logo Chromium.')
}

let rcedit
try {
  // rcedit ≥5 is ESM with a NAMED export; older versions used the default export.
  const mod = await import('rcedit')
  rcedit = mod.rcedit || mod.default
  if (typeof rcedit !== 'function') throw new Error('rcedit export không phải hàm')
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
