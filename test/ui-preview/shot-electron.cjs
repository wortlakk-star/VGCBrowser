// Launch the REAL Electron app (production build in out/) with a debug port and screenshot its
// first window — validates the renderer bundle, CSP and self-hosted fonts in the real runtime.
//   node test/ui-preview/shot-electron.cjs   (needs `npm run build` first)
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const WebSocket = require('ws')
const electron = require('electron') // path to the binary
const port = 9333
const root = path.resolve(__dirname, '..', '..')
const outDir = path.resolve(__dirname, 'shots')
fs.mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)) }).on('error', rej))

async function main() {
  const proc = spawn(electron, [root, `--remote-debugging-port=${port}`], { stdio: 'ignore', env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e })() })
  let targets = []
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try { targets = JSON.parse(await get(`http://127.0.0.1:${port}/json`)).filter((t) => t.type === 'page') } catch {}
    if (targets.length) break
  }
  if (!targets.length) throw new Error('no page target — app did not open a window')
  await sleep(2500) // let React + fonts settle
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  let id = 0; const pending = new Map()
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id) } })
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const info = await send('Runtime.evaluate', { expression: 'JSON.stringify({ title: document.title, fonts: document.fonts.check("14px Inter"), errs: (window.__errs||[]).length, w: innerWidth, h: innerHeight, url: location.href })', returnByValue: true })
  console.log('page:', info.result?.result?.value)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(outDir, 'electron-real.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('saved electron-real.png')
  ws.close()
  try { proc.kill() } catch {}
  await sleep(500)
  try { require('child_process').execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' }) } catch {}
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
