// Kiểm tra cổng chặn bản cũ (src/main/version-gate.ts) với min-version.json THẬT trên vgcbrowser.com.
// Chạy: node version-gate-live.cjs   (cần `npm i` trong thư mục này để có esbuild)
const fs = require('fs'), path = require('path')
const { build } = require('esbuild')
const here = __dirname
fs.writeFileSync(path.join(here, 'stub-electron-gate.cjs'),
  "module.exports = { app: { getVersion: () => process.env.FAKE_VERSION, get isPackaged() { return process.env.FAKE_PACKAGED !== '0' } } }\n")
fs.writeFileSync(path.join(here, 'entry-gate.ts'), "export { checkVersionGate } from '../../src/main/version-gate'\n")
const out = { steps: [], fails: [] }
const check = (n, c, x) => { out.steps.push((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')); if (!c) out.fails.push(n) }
;(async () => {
  await build({ entryPoints: [path.join(here, 'entry-gate.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(here, 'bundle-gate.cjs'), logLevel: 'warning',
    plugins: [{ name: 's', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(here, 'stub-electron-gate.cjs') })) } }] })
  const { checkVersionGate } = require('./bundle-gate.cjs')
  const run = async (v) => { process.env.FAKE_VERSION = v; return checkVersionGate() }
  const live = await (await fetch('https://vgcbrowser.com/dl/min-version.json?t=' + Date.now())).json()
  check('server dang dat minVersion', typeof live.minVersion === 'string', live)
  for (const v of ['2.1.69', '2.1.80', '2.1.82', '2.1.83']) {
    const r = await run(v)
    check('ban ' + v + ' -> BI CHAN', r.blocked === true && r.min === live.minVersion, r)
  }
  const cur = await run(live.minVersion)
  check('ban ' + live.minVersion + ' (moi nhat) -> KHONG bi chan', cur.blocked === false, cur)
  const newer = await run('2.1.99')
  check('ban 2.1.99 (moi hon) -> KHONG bi chan', newer.blocked === false)
  process.env.FAKE_PACKAGED = '0'
  const dev = await run('2.0.0'); delete process.env.FAKE_PACKAGED
  check('chay dev (chua dong goi) khong bao gio bi chan', dev.blocked === false)
  const realFetch = global.fetch
  global.fetch = async () => { throw new Error('mat mang') }
  const offline = await run('2.1.50'); global.fetch = realFetch
  check('mat mang -> MO (khong khoa nham nguoi dung)', offline.blocked === false, offline)
  global.fetch = async () => new Response('khong phai json', { status: 200 })
  const bad = await run('2.1.50'); global.fetch = realFetch
  check('file hong -> MO (khong khoa nham)', bad.blocked === false, bad)
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.fails.length ? 1 : 0)
})().catch((e) => { out.error = String(e && e.stack || e); console.log(JSON.stringify(out, null, 1)); process.exit(1) })
