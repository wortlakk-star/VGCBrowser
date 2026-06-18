// ── VGC Browser — build a multi-size .ico from PNG frames ────────────────────
// Packs pre-resized PNGs (ico_<size>.png) into a single Windows .ico using PNG
// entries (supported Windows Vista+). Pure Node — no image library needed.
//
//   node scripts/make-ico.mjs <dirWithPngFrames> <out.ico>
//
// Frames expected: ico_16.png ico_24.png ico_32.png ico_48.png ico_64.png
//                  ico_128.png ico_256.png  (missing sizes are skipped)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const out = process.argv[3]
if (!dir || !out) {
  console.error('Usage: node scripts/make-ico.mjs <dir> <out.ico>')
  process.exit(1)
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const frames = SIZES.map((s) => ({ size: s, file: join(dir, `ico_${s}.png`) }))
  .filter((f) => existsSync(f.file))
  .map((f) => ({ size: f.size, data: readFileSync(f.file) }))

if (!frames.length) {
  console.error('make-ico: không thấy frame PNG nào trong', dir)
  process.exit(1)
}

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(frames.length, 4) // image count

let offset = 6 + frames.length * 16
const entries = []
for (const f of frames) {
  const e = Buffer.alloc(16)
  const dim = f.size >= 256 ? 0 : f.size // 0 means 256 in the ICO spec
  e.writeUInt8(dim, 0) // width
  e.writeUInt8(dim, 1) // height
  e.writeUInt8(0, 2) // palette colors (0 = none)
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // color planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(f.data.length, 8) // bytes of image data
  e.writeUInt32LE(offset, 12) // offset of image data
  offset += f.data.length
  entries.push(e)
}

writeFileSync(out, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]))
console.log(`✓ Đã tạo ${out} (${frames.length} kích thước: ${frames.map((f) => f.size).join(', ')})`)
