// Lái app VGC trên máy Windows của CI qua cổng gỡ lỗi: chờ màn hình bắt buộc cập nhật tải xong
// bản mới rồi bấm "Cập nhật ngay" (window.vgc.installUpdate) — đúng như nhân viên bấm.
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function page() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json()
      const p = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (p) return p
    } catch {}
    await sleep(2000)
  }
  throw new Error('không thấy cửa sổ app')
}
async function evalIn(expr) {
  const p = await page()
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const res = await new Promise((r) => {
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.id === 1) r(d.result) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  return res?.result?.value
}
;(async () => {
  const t0 = Date.now()
  const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
  console.log(`[${el()}] phiên bản đang chạy:`, await evalIn('return await window.vgc.getVersion()'))
  console.log(`[${el()}] màn hình:`, (await evalIn('return document.body.innerText.slice(0,160)'))?.replace(/\n/g, ' | '))
  for (let i = 0; i < 180; i++) {
    const s = await evalIn('const s = await window.vgc.getUpdateStatus(); return JSON.stringify({phase:s.phase,v:s.newVersion,p:s.percent,m:s.message,manual:s.manualDownloadUrl})')
    if (i % 5 === 0 || /downloaded|error/.test(s)) console.log(`[${el()}] cập nhật:`, s)
    if (/"phase":"downloaded"/.test(s)) {
      console.log(`[${el()}] bấm "Cập nhật ngay"`)
      await evalIn('setTimeout(() => window.vgc.installUpdate(), 50); return 1').catch(() => {})
      process.exit(0)
    }
    if (/"phase":"error"/.test(s)) process.exit(2)
    await sleep(3000)
  }
  console.log('hết giờ chờ tải'); process.exit(3)
})().catch((e) => { console.error(e); process.exit(4) })
