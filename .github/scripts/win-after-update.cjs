// Đọc màn hình + trạng thái cập nhật của bản vừa cài (cổng gỡ lỗi 9222).
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  let p
  for (let i = 0; i < 40 && !p; i++) {
    try { p = (await (await fetch('http://127.0.0.1:9222/json')).json()).find((t) => t.type === 'page' && t.url.startsWith('file:')) } catch {}
    if (!p) await sleep(2000)
  }
  if (!p) { console.log('không thấy cửa sổ app'); return }
  await sleep(15000)
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((r) => ws.once('open', r))
  const v = await new Promise((r) => {
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.id === 1) r(d.result?.result?.value) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async()=>JSON.stringify({ver: await window.vgc.getVersion(), upd: await window.vgc.getUpdateStatus(), gate: await window.vgc.versionGate(), screen: document.body.innerText.slice(0,200)}))()`, awaitPromise: true, returnByValue: true } }))
  })
  console.log('app sau cập nhật:', v)
  ws.close()
})()
