// Audits every profile of the logged-in account: live-checks each proxy and
// reports {id, name, proxy, status: ok|dead|no-proxy}. READ-ONLY (no deletes).
// Usage: node test/profile-audit.cjs <appWindowWebSocketDebuggerUrl>
const WebSocket = require('ws')
const ws = new WebSocket(process.argv[2], { perMessageDeflate: false })
let id = 0
const pending = {}
function send(method, params) {
  return new Promise((res) => {
    const i = ++id
    pending[i] = res
    ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  })
}
ws.on('message', (m) => {
  const o = JSON.parse(m)
  if (o.id && pending[o.id]) {
    pending[o.id](o)
    delete pending[o.id]
  }
})
const audit = `(async () => {
  if (!window.vgc || !window.vgc.listProfiles) return { error: 'window.vgc unavailable' };
  const ps = await window.vgc.listProfiles();
  const results = await Promise.all(ps.map(async (p) => {
    const base = { id: p.id, name: p.name, type: (p.proxy && p.proxy.type) || 'none', host: (p.proxy && p.proxy.host) || '' };
    if (!p.proxy || p.proxy.type === 'none') return Object.assign(base, { status: 'no-proxy' });
    try {
      const r = await window.vgc.checkProxy(p.proxy);
      return Object.assign(base, { status: (r && r.ok) ? 'ok' : 'dead', ip: (r && r.ip) || '', err: (r && r.error) || '' });
    } catch (e) {
      return Object.assign(base, { status: 'dead', err: String(e) });
    }
  }));
  return { count: ps.length, results };
})()`
ws.on('open', async () => {
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', {
    expression: audit,
    returnByValue: true,
    awaitPromise: true,
    timeout: 90000
  })
  const cmd = r.result || {}
  if (cmd.exceptionDetails) {
    console.log('EVAL EXCEPTION: ' + JSON.stringify(cmd.exceptionDetails.exception || cmd.exceptionDetails))
  } else {
    console.log(JSON.stringify(cmd.result && cmd.result.value, null, 2))
  }
  ws.close()
  process.exit(0)
})
ws.on('error', (e) => { console.log('WS ERROR: ' + e.message); process.exit(1) })
setTimeout(() => { console.log('timeout'); process.exit(1) }, 100000)
