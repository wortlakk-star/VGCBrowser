// ── VGC Browser — strip the white HALO/glow from the logo icon ────────────────
// The source logo (src/renderer/assets/logo.png → resources/icon.png) has a soft
// WHITE GLOW + drop shadow around the sphere. On a dark taskbar that glow reads as a
// "viền trắng" (white border) around the icon. This removes it: any WHITISH / GREY
// pixel that is NOT fully opaque is the glow/shadow/anti-alias fringe → set fully
// transparent. Kept intact: the coloured sphere (saturated, matched by hue not
// lightness), the SOLID white core of the sphere (alpha 255), and the SOLID "VGC"
// wordmark (alpha 255). A circular clip removes any residual glow beyond the sphere.
//
//   node scripts/clean-icon.mjs            # writes resources/icon.png (cleaned) + a
//                                          # magenta preview to scratchpad for review
// Pure Node — hand PNG decode/encode (no image lib), same codec as build-transparent-icon.mjs.

import zlib from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

function decodePng(path) {
  const buf = readFileSync(path)
  let p = 8, w, h, colorType
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride), rp = 0
  for (let y = 0; y < h; y++) {
    const f = raw[rp++]; const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0
      let v = raw[rp + x]
      if (f === 1) v = (v + a) & 255
      else if (f === 2) v = (v + b) & 255
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; v = (v + pr) & 255 }
      cur[x] = v
    }
    rp += stride; cur.copy(out, y * stride); prev = cur
  }
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    if (ch === 4) { rgba[i*4]=out[i*4]; rgba[i*4+1]=out[i*4+1]; rgba[i*4+2]=out[i*4+2]; rgba[i*4+3]=out[i*4+3] }
    else { rgba[i*4]=out[i*ch]; rgba[i*4+1]=out[i*ch+1]; rgba[i*4+2]=out[i*ch+2]; rgba[i*4+3]=255 }
  }
  return { w, h, data: rgba }
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xedb88320^(c>>>1) : c>>>1; t[n]=c>>>0 } return t })()
function crc32(b){ let c=0xffffffff; for(let i=0;i<b.length;i++) c=crcTable[(c^b[i])&0xff]^(c>>>8); return (c^0xffffffff)>>>0 }
function chunk(type,data){ const len=Buffer.alloc(4); len.writeUInt32BE(data.length); const t=Buffer.from(type,'ascii'); const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t,data]))); return Buffer.concat([len,t,data,crc]) }
function encodePng(w,h,rgba){ const raw=Buffer.alloc(h*(1+w*4)); for(let y=0;y<h;y++){ raw[y*(1+w*4)]=0; rgba.copy(raw,y*(1+w*4)+1,y*w*4,(y+1)*w*4) } const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=6; return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]) }

// ── clean ─────────────────────────────────────────────────────────────────────
const SRC = process.argv[2] || 'resources/icon.png'
const OUT = process.argv[3] || 'resources/icon.png'
const img = decodePng(SRC)
const { w, h, data } = img

// 1) Find the coloured sphere's bounding circle from SATURATED, opaque pixels
//    (blue/teal). The white halo is desaturated, so it never enters this box → the
//    circle sits at the sphere's true edge and clips the glow just outside it.
let minX = w, minY = h, maxX = 0, maxY = 0
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4, a = data[i+3]
  if (a < 200) continue
  const r = data[i], g = data[i+1], b = data[i+2]
  const sat = Math.max(r,g,b) - Math.min(r,g,b)
  if (sat > 55) { if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y }
}
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
const radius = Math.max(maxX - minX, maxY - minY) / 2 + 3 // +3px so we never bite the rim
// Locate the ACTUAL "VGC" wordmark: the wide block of bright, opaque white glyph pixels
// in the lower part of the canvas. Anything between the sphere and this block (the soft
// drop-shadow) is NOT text and gets cleared. Scan rows below the sphere and take the top
// of the first row-run that has a wide spread of glyph pixels.
let textTop = h // default: no text found → nothing preserved below the sphere
for (let y = maxY + 8; y < h; y++) {
  let cnt = 0
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    if (data[i+3] > 205 && Math.max(data[i], data[i+1], data[i+2]) > 180) cnt++
  }
  if (cnt > w * 0.06) { textTop = y; break } // ~6% of the width lit = a glyph row, not a shadow wisp
}

let killedHalo = 0, killedOutside = 0
const outp = Buffer.from(data)
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4
  const a = outp[i+3]; if (a === 0) continue
  const r = outp[i], g = outp[i+1], b = outp[i+2]
  const sat = Math.max(r,g,b) - Math.min(r,g,b)
  const light = Math.max(r,g,b)
  const dist = Math.hypot(x - cx, y - cy)

  const inSphere = dist <= radius
  const inText = y >= textTop
  // Rule A — geometry: kill anything outside the sphere that isn't in the text band
  //          (that's the glow ring + drop shadow surrounding the sphere).
  if (!inSphere && !inText) { outp[i+3] = 0; killedOutside++; continue }
  // Rule B — colour: below the sphere, keep only the SOLID white glyphs of the "VGC"
  //          wordmark; drop the soft drop-shadow and the glow around the letters
  //          (both are semi-transparent, so a high alpha gate removes them while the
  //          solid glyphs — alpha ~255 — survive).
  if (inText) {
    const isGlyph = light > 175 && a > 208
    if (!isGlyph) { outp[i+3] = 0; continue }
  }
  // Rule C — inside the sphere, strip any semi-transparent whitish glow that leaked in
  //          just inside the rim (keeps the SOLID white core: alpha 255).
  if (inSphere && sat < 26 && light > 150 && a < 250 && dist > radius * 0.6) {
    outp[i+3] = 0; killedHalo++
  }
}

writeFileSync(OUT, encodePng(w, h, outp))
console.log(`cleaned ${SRC} -> ${OUT}  (sphere c=${cx.toFixed(0)},${cy.toFixed(0)} r=${radius.toFixed(0)}; killed halo=${killedHalo}, outside=${killedOutside})`)

// magenta preview for review
const prev = Buffer.alloc(w * h * 4)
for (let i = 0; i < w * h; i++) {
  const a = outp[i*4+3] / 255
  prev[i*4]   = Math.round(outp[i*4]   * a + 255 * (1 - a))
  prev[i*4+1] = Math.round(outp[i*4+1] * a + 0   * (1 - a))
  prev[i*4+2] = Math.round(outp[i*4+2] * a + 255 * (1 - a))
  prev[i*4+3] = 255
}
const prevPath = process.env.PREVIEW || 'scratch-clean-preview.png'
writeFileSync(prevPath, encodePng(w, h, prev))
console.log(`preview (on magenta): ${prevPath}`)
