// Mirrors cloud-data.ts walk()/buildZip() to validate: caches excluded,
// directory structure preserved, file content intact through a zip round-trip.
const AdmZip = require('adm-zip')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache'])
function walk(zip, root, dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue
      walk(zip, root, full)
    } else if (e.isFile()) {
      const relDir = path.relative(root, dir).split(path.sep).join('/')
      zip.addLocalFile(full, relDir, e.name)
    }
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-prof-'))
fs.mkdirSync(path.join(root, 'Default', 'Network'), { recursive: true })
fs.writeFileSync(path.join(root, 'Local State'), 'state')
fs.writeFileSync(path.join(root, 'Default', 'Cookies'), 'cookiedata')
fs.writeFileSync(path.join(root, 'Default', 'Network', 'Cookies'), 'netcookie')
fs.mkdirSync(path.join(root, 'Default', 'Cache'), { recursive: true })
fs.writeFileSync(path.join(root, 'Default', 'Cache', 'big.bin'), Buffer.alloc(1024))

const zip = new AdmZip()
walk(zip, root, root)
const buf = zip.toBuffer()

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-out-'))
new AdmZip(buf).extractAllTo(out, true)

const checks = [
  ['Local State kept', fs.existsSync(path.join(out, 'Local State'))],
  ['Default/Cookies kept', fs.existsSync(path.join(out, 'Default', 'Cookies'))],
  ['Default/Network/Cookies kept', fs.existsSync(path.join(out, 'Default', 'Network', 'Cookies'))],
  ['Cache excluded', !fs.existsSync(path.join(out, 'Default', 'Cache'))],
  ['cookie content intact', fs.readFileSync(path.join(out, 'Default', 'Cookies'), 'utf8') === 'cookiedata']
]
let ok = true
for (const [n, v] of checks) {
  console.log((v ? 'PASS ' : 'FAIL ') + n)
  if (!v) ok = false
}
console.log(ok ? 'ALL PASS (5/5)' : 'SOME FAILED')
process.exit(ok ? 0 : 1)
