// E2E extension khoá cửa sổ (lock-ext.ts) trong engine VGC, với máy chủ giả. Lấy mã extension
// trực tiếp từ src/main/lock-ext.ts nên luôn kiểm tra đúng bản đang phát hành.
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os')
const { spawn, execSync } = require('child_process')
const ROOT = path.join(__dirname, '..', '..')
const src = fs.readFileSync(path.join(ROOT, 'src/main/lock-ext.ts'), 'utf8').replace(/\r/g, '')
const grab = (name) => {
  const start = src.indexOf('const ' + name + ' = ')
  if (start < 0) throw new Error('no ' + name)
  const open = src.indexOf('`', start)
  const close = src.indexOf('`\n', open + 1)
  return src.slice(open + 1, close)
}
const BG = grab('BACKGROUND_JS'), HTML = grab('LOCK_HTML'), JS = grab('LOCK_JS')
const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'VGC Lock', version: '1.0', permissions: ['idle', 'storage', 'alarms'], host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const unlockCalls = []
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  if (req.url.startsWith('/cfg')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ idleMin: 5 })) }
  let b = ''
  req.on('data', (d) => (b += d))
  req.on('end', () => {
    const j = JSON.parse(b || '{}'); unlockCalls.push(j)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(j.pw === 'abc' ? { ok: true, action: 'ok' } : { ok: false, action: 'wrong', remainingProfile: 2 }))
  })
})
const out = { steps: [], fails: [] }
const check = (n, c, x) => { out.steps.push((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')); if (!c) out.fails.push(n) }
const cdp = (wsUrl) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl); let id = 0; const pend = {}
  ws.onopen = () => resolve({ ev: (expr) => new Promise((res) => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })) }) })
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d.result) }
  ws.onerror = reject
})
;(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port
  const extDir = path.join(os.tmpdir(), 'vgc-lock-e2e-ext'); fs.rmSync(extDir, { recursive: true, force: true }); fs.mkdirSync(extDir, { recursive: true })
  fs.writeFileSync(path.join(extDir, 'manifest.json'), MANIFEST)
  fs.writeFileSync(path.join(extDir, 'config.js'), 'var VGC = ' + JSON.stringify({ port, token: 'tok' }) + ';\n')
  fs.writeFileSync(path.join(extDir, 'background.js'), BG)
  fs.writeFileSync(path.join(extDir, 'lock.html'), HTML)
  fs.writeFileSync(path.join(extDir, 'lock.js'), JS)
  const ud = path.join(os.tmpdir(), 'vgc-lock-e2e-ud'); fs.rmSync(ud, { recursive: true, force: true })
  const eng = process.env.VGC_ENGINE || path.join(ROOT, 'engine/chromium/chrome.exe'); const dbg = 9411
  const p = spawn(eng, ['--remote-debugging-port=' + dbg, '--user-data-dir=' + ud, '--load-extension=' + extDir, '--disable-extensions-except=' + extDir, '--disable-features=ExtensionDisableUnsupportedDeveloper', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  const wins = 'chrome.windows.getAll().then(w=>w.map(x=>({id:x.id,type:x.type,state:x.state})))'
  try {
    let sw = null
    for (let i = 0; i < 40 && !sw; i++) {
      await sleep(500)
      try {
        const l = await (await fetch('http://127.0.0.1:' + dbg + '/json/list')).json()
        for (const t of l.filter((x) => x.type === 'service_worker' && /background\.js$/.test(x.url))) {
          const c = await cdp(t.webSocketDebuggerUrl)
          const r = await c.ev('typeof VGC')
          if (r.result && r.result.value === 'object') { sw = t; break }
        }
      } catch (e) {}
    }
    if (!sw) throw new Error('khong thay service worker cua extension khoa')
    const s = await cdp(sw.webSocketDebuggerUrl)
    check('arm(): doc cau hinh tu may chu, bat tu khoa', (await s.ev('(async()=>{await arm(); return (await chrome.storage.session.get("armed")).armed})()')).result.value === true)
    const before = (await s.ev(wins)).result.value
    check('truoc khi khoa: 1 cua so binh thuong', before.length === 1 && before[0].state === 'normal', before)
    await s.ev('lock()'); await sleep(1500)
    const after = (await s.ev(wins)).result.value
    check('sau khi khoa: cua so chinh THU NHO + co popup nhap mat khau', after.some((w) => w.type === 'normal' && w.state === 'minimized') && after.some((w) => w.type === 'popup'), after)
    let page = null
    for (let i = 0; i < 20 && !page; i++) { const l = await (await fetch('http://127.0.0.1:' + dbg + '/json/list')).json(); page = l.find((t) => t.type === 'page' && /lock\.html$/.test(t.url)); if (!page) await sleep(300) }
    if (!page) throw new Error('khong thay trang lock.html')
    const pg = await cdp(page.webSocketDebuggerUrl)
    await pg.ev("document.getElementById('pw').value='sai'; document.getElementById('go').click()"); await sleep(1200)
    const msg = (await pg.ev("document.getElementById('msg').textContent")).result.value
    check('nhap sai: bao con 2 lan va VAN KHOA', msg.includes('Còn 2 lần') && (await s.ev('chrome.storage.session.get("locked").then(x=>x.locked)')).result.value === true, msg)
    await pg.ev("document.getElementById('pw').value='abc'; document.getElementById('go').click()"); await sleep(2200)
    check('nhap dung: het khoa', (await s.ev('chrome.storage.session.get("locked").then(x=>x.locked)')).result.value === false)
    const restored = (await s.ev(wins)).result.value
    check('nhap dung: cua so khoi phuc, popup dong', restored.length === 1 && restored[0].state === 'normal', restored)
    check('may chu nhan dung 2 lan thu mat khau (sai, dung)', JSON.stringify(unlockCalls.map((c) => c.pw)) === JSON.stringify(['sai', 'abc']), unlockCalls.map((c) => c.pw))
  } catch (e) { out.error = String(e.message || e) }
  finally { try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }) } catch (e) {} srv.close() }
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.fails.length || out.error ? 1 : 0)
})()
