// Reads back the live fingerprint of an open profile tab via CDP.
// Usage: node test/fp-check.cjs <pageWebSocketDebuggerUrl>
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
async function rb() {
  function canvasHash() {
    var c = document.createElement('canvas')
    c.width = 220
    c.height = 50
    var x = c.getContext('2d')
    x.textBaseline = 'top'
    x.font = '14px Arial'
    x.fillStyle = '#069'
    x.fillText('VGC fingerprint test \u{1F600}', 2, 2)
    return c.toDataURL()
  }
  var h1 = canvasHash()
  var h2 = canvasHash()
  var webgl = 'err'
  try {
    var gl = document.createElement('canvas').getContext('webgl')
    var e = gl.getExtension('WEBGL_debug_renderer_info')
    webgl = [gl.getParameter(e.UNMASKED_VENDOR_WEBGL), gl.getParameter(e.UNMASKED_RENDERER_WEBGL)]
  } catch (_) {}
  // Font enforcement check.
  function fcheck(f) { try { return document.fonts.check(f) } catch (_) { return 'err' } }
  // WebRTC leak test: gather ICE candidates via onicecandidate (the path we patch).
  var rtcCands = []
  try {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    pc.createDataChannel('x')
    pc.onicecandidate = function (ev) { if (ev && ev.candidate) rtcCands.push(ev.candidate.candidate) }
    var off = await pc.createOffer()
    await pc.setLocalDescription(off)
    await new Promise(function (res) { setTimeout(res, 2500) })
    pc.close()
  } catch (e) { rtcCands = ['err:' + e.message] }
  var rawIpLeak = rtcCands.filter(function (c) {
    return /(\d{1,3}\.){3}\d{1,3}/.test(c) && c.indexOf('.local') === -1
  })
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    cores: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: [screen.width, screen.height],
    webgl: webgl,
    uaDataPlatform: (navigator.userAgentData && navigator.userAgentData.platform) || 'none',
    canvasStable: h1 === h2,
    fontReal_Arial: fcheck('12px Arial'),
    fontFake_ZZ: fcheck('12px "ZZNoSuchFont123"'),
    webrtcCandidates: rtcCands.length,
    webrtcRawIpLeak: rawIpLeak.length,
    webrtcSample: rtcCands.slice(0, 3)
  }
}
ws.on('open', async () => {
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', {
    expression: '(' + rb.toString() + ')()',
    returnByValue: true,
    awaitPromise: true
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
ws.on('error', (e) => {
  console.log('WS ERROR: ' + e.message)
  process.exit(1)
})
setTimeout(() => {
  console.log('timeout')
  process.exit(1)
}, 15000)
