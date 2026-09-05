// Screenshot the built UI preview with headless Chrome over the CDP pipe.
//   node test/ui-preview/shot.cjs [--out test/ui-preview/shots] [--chrome <exe>]
// Produces app-dark.png, app-light.png, auth-dark.png, plus modal shots (create, settings).
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const args = process.argv.slice(2)
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt)
const outDir = path.resolve(arg('--out', 'test/ui-preview/shots'))
const chrome = arg('--chrome', process.env.VGC_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
const dist = path.resolve(arg('--dist', path.join(__dirname, 'dist')))
const prefix = arg('--prefix', '') // e.g. "old-" to shoot a second build into the same folder
const basic = args.includes('--basic') // only the main screen + auth (no modal clicks)
fs.mkdirSync(outDir, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(dist, url === '/' ? 'index.html' : url)
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vgc-shot-'))
  const proc = spawn(chrome, [
    `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--disable-extensions',
    '--window-size=1440,900', '--force-device-scale-factor=1', '--hide-scrollbars',
    '--remote-debugging-pipe', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const w = proc.stdio[3], r = proc.stdio[4]
  let buf = Buffer.alloc(0), nextId = 1
  const pending = new Map()
  const events = []
  r.on('data', (c) => {
    buf = Buffer.concat([buf, c]); let i
    while ((i = buf.indexOf(0)) !== -1) {
      const m = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 1)
      try { const j = JSON.parse(m); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id) } else if (j.method) events.push(j) } catch {}
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = nextId++; pending.set(id, (j) => (j.error ? rej(new Error(j.error.message)) : res(j.result || {})))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, 30000)
    w.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0')
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)

  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.value
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    fs.writeFileSync(path.join(outDir, prefix + name + '.png'), Buffer.from(data, 'base64'))
    console.log('saved', prefix + name + '.png')
  }
  const open = async (query) => {
    await send('Page.navigate', { url: `${base}/index.html${query}` }, sessionId)
    await sleep(1400)
    const errs = await evalJs('(window.__errs||[]).join("\\n")')
    if (errs) console.log('page errors:', errs)
  }
  const click = async (sel) => { await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'MISSING ' + ${JSON.stringify(sel)}; el.click(); return 'ok' })()`); await sleep(500) }

  await open('?theme=dark'); await shot('app-dark')
  if (basic) {
    await open('?theme=light'); await shot('app-light')
    await open('?theme=dark&screen=auth'); await shot('auth-dark')
    await send('Browser.close').catch(() => {})
    await Promise.race([new Promise((r) => proc.on('exit', r)), sleep(5000)])
    try { proc.kill() } catch {}
    server.close()
    fs.rmSync(profile, { recursive: true, force: true })
    return
  }
  // bulk selection bar + a sticky warning toast
  await click('tbody tr:nth-child(2) input[type=checkbox]'); await click('tbody tr:nth-child(3) input[type=checkbox]')
  await evalJs(`window.__emit.dataSync({ id: 'x', phase: 'warn', sticky: true, message: 'Máy MacBook không phản hồi (đang ngủ / mất mạng?) — mở bằng bản cloud gần nhất; những gì làm trên máy đó sau lần lưu cuối chưa có ở đây.' })`)
  await sleep(300); await shot('app-dark-bulk-toast')
  await evalJs('document.querySelector(".toast")?.click()'); await click('.bulkbar .icon-btn')
  // row ⋯ menu
  await click('tbody tr:nth-child(1) .row-actions .icon-btn'); await shot('app-dark-rowmenu'); await evalJs('document.body.click()'); await sleep(200)
  // toolbar "Công cụ" dropdown
  await click('.toolbar .dd:last-of-type > .btn'); await shot('app-dark-tools'); await evalJs('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))'); await sleep(200)
  await click('.add-profile'); await shot('modal-create-dark'); await evalJs('document.querySelector(".modal-backdrop")?.click()')
  await click('.side-settings'); await shot('modal-settings-dark'); await evalJs('document.querySelector(".modal-backdrop")?.click()')
  await click('.nav > .nav-row:last-child'); await shot('modal-proxy-dark'); await evalJs('document.querySelector(".modal-backdrop")?.click()')
  await open('?theme=light'); await shot('app-light')
  await open('?theme=dark&screen=auth'); await shot('auth-dark')
  await open('?theme=light&screen=auth'); await shot('auth-light')

  await send('Browser.close').catch(() => {})
  await Promise.race([new Promise((r) => proc.on('exit', r)), sleep(5000)])
  try { proc.kill() } catch {}
  server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
