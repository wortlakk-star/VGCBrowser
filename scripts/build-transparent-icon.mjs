// ── VGC Browser — rebuild resources/icon.png with a TRANSPARENT background ────
// Composites the clean transparent globe (src/renderer/assets/logo.png) + the
// "VGC" wordmark (lifted from the old icon.png, which had white text on a dark
// square) onto a fully transparent 1024×1024 canvas — i.e. same logo + text, but
// no dark rounded-square behind it. Pure Node (hand PNG decode/encode).

import zlib from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

// ── PNG decode (8-bit, colour type 2/6, no interlace) ────────────────────────
function decodePng(path) {
  const buf = readFileSync(path)
  let p = 8
  let w, h, colorType
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const f = raw[rp++]
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = raw[rp + x]
      if (f === 1) v = (v + a) & 255
      else if (f === 2) v = (v + b) & 255
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (v + pr) & 255
      }
      cur[x] = v
    }
    rp += stride
    cur.copy(out, y * stride)
    prev = cur
  }
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    if (ch === 4) {
      rgba[i * 4] = out[i * 4]
      rgba[i * 4 + 1] = out[i * 4 + 1]
      rgba[i * 4 + 2] = out[i * 4 + 2]
      rgba[i * 4 + 3] = out[i * 4 + 3]
    } else {
      rgba[i * 4] = out[i * ch]
      rgba[i * 4 + 1] = out[i * ch + 1]
      rgba[i * 4 + 2] = out[i * ch + 2]
      rgba[i * 4 + 3] = 255
    }
  }
  return { w, h, data: rgba }
}

// ── PNG encode (RGBA) ────────────────────────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
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
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ── bilinear downscale ───────────────────────────────────────────────────────
function scale(src, dw, dh) {
  const { w: sw, h: sh, data } = src
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * sh) / dh - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * sw) / dw - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = sx - x0
      const o = (y * dw + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = data[(y0 * sw + x0) * 4 + c]
        const p10 = data[(y0 * sw + x1) * 4 + c]
        const p01 = data[(y1 * sw + x0) * 4 + c]
        const p11 = data[(y1 * sw + x1) * 4 + c]
        const top = p00 + (p10 - p00) * fx
        const bot = p01 + (p11 - p01) * fx
        out[o + c] = Math.round(top + (bot - top) * fy)
      }
    }
  }
  return { w: dw, h: dh, data: out }
}

// ── build ────────────────────────────────────────────────────────────────────
const SIZE = 1024
const icon = decodePng('resources/icon.png') // logo + VGC text on dark square
const logo = decodePng('src/renderer/assets/logo.png') // clean transparent globe

const canvas = Buffer.alloc(SIZE * SIZE * 4) // transparent

// 1) globe: scale the transparent logo and composite it in the upper area
const GLOBE = Number(process.env.GLOBE || 720)
const GX = Math.round((SIZE - GLOBE) / 2)
const GY = Number(process.env.GY || 20)
const g = scale(logo, GLOBE, GLOBE)
for (let y = 0; y < GLOBE; y++) {
  for (let x = 0; x < GLOBE; x++) {
    const cx = GX + x
    const cy = GY + y
    if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) continue
    const s = (y * GLOBE + x) * 4
    const a = g.data[s + 3]
    if (a === 0) continue
    const o = (cy * SIZE + cx) * 4
    // over-composite onto (transparent) canvas
    const af = a / 255
    canvas[o] = g.data[s]
    canvas[o + 1] = g.data[s + 1]
    canvas[o + 2] = g.data[s + 2]
    canvas[o + 3] = Math.max(canvas[o + 3], a)
    void af
  }
}

// 2) VGC wordmark: lift the white text from the old icon's bottom band. There the
//    background is a uniform dark navy, so a luminance key gives clean white text.
const TEXT_TOP = Number(process.env.TT || 715)
const TEXT_BOT = Number(process.env.TB || 940)
const THRESH = Number(process.env.TH || 55)
for (let y = TEXT_TOP; y < TEXT_BOT; y++) {
  for (let x = 0; x < SIZE; x++) {
    const s = (y * SIZE + x) * 4
    const r = icon.data[s]
    const gg = icon.data[s + 1]
    const b = icon.data[s + 2]
    const lum = 0.299 * r + 0.587 * gg + 0.114 * b
    if (lum <= THRESH) continue
    // alpha ramps from 0 at THRESH to 255 at ~200 → keeps anti-aliased edges
    const a = Math.max(0, Math.min(255, Math.round(((lum - THRESH) / (205 - THRESH)) * 255)))
    if (a === 0) continue
    const o = (y * SIZE + x) * 4
    if (a > canvas[o + 3]) {
      canvas[o] = 255
      canvas[o + 1] = 255
      canvas[o + 2] = 255
      canvas[o + 3] = a
    }
  }
}

writeFileSync('resources/icon.png', encodePng(SIZE, SIZE, canvas))
console.log(`wrote resources/icon.png — transparent bg, globe=${GLOBE}@${GY}, text ${TEXT_TOP}-${TEXT_BOT}`)
