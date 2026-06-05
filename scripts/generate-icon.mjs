// ── VGC Browser — icon generator ─────────────────────────────────────────────
// Writes resources/icon.png (256x256 RGBA): dark background + accent diamond
// (the ◆ brand mark). Pure Node — encodes the PNG by hand (zlib + CRC32) so no
// image library is needed. electron-builder converts it to .ico when packaging.

import zlib from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const W = 256
const H = 256

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

// Raw image: each scanline starts with a filter byte (0) then RGBA pixels.
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4)
  raw[rowStart] = 0 // filter: none
  for (let x = 0; x < W; x++) {
    const d = Math.abs(x - 128) + Math.abs(y - 128) // diamond distance
    let r = 15
    let g = 17
    let b = 21 // bg #0f1115
    if (d <= 98) {
      r = 79
      g = 124
      b = 255
    } // accent #4f7cff
    if (d <= 60) {
      r = 58
      g = 91
      b = 208
    } // inner shade
    const o = rowStart + 1 + x * 4
    raw[o] = r
    raw[o + 1] = g
    raw[o + 2] = b
    raw[o + 3] = 255
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.png', png)
console.log(`wrote resources/icon.png (${png.length} bytes)`)
