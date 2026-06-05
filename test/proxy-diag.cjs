const { SocksClient } = require('socks')
const tls = require('tls')

// Proxy doc tu BIEN MOI TRUONG (KHONG hardcode credential vao source).
// Truoc khi chay (PowerShell):
//   $env:PROXY_HOST='1.2.3.4'; $env:PROXY_PORT='12324'; $env:PROXY_USER='user'; $env:PROXY_PASS='pass'; node test/proxy-diag.cjs
const PROXY = {
  host: process.env.PROXY_HOST || '127.0.0.1',
  port: Number(process.env.PROXY_PORT) || 1080,
  type: 5,
  userId: process.env.PROXY_USER || '',
  password: process.env.PROXY_PASS || ''
}

async function testHttps(label, host, path) {
  const t0 = Date.now()
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: PROXY,
      command: 'connect',
      destination: { host, port: 443 },
      timeout: 9000
    })
    const raw = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
        t.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`)
      })
      let d = ''
      t.setTimeout(9000, () => t.destroy(new Error('tls read timeout')))
      t.setEncoding('utf8')
      t.on('data', (x) => (d += x))
      t.on('end', () => resolve(d))
      t.on('close', () => resolve(d))
      t.on('timeout', () => t.destroy(new Error('tls read timeout')))
      t.on('error', reject)
    })
    const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
    console.log(`OK  ${label} ${Date.now() - t0}ms ::`, body.replace(/\s+/g, ' ').slice(0, 260))
  } catch (e) {
    console.log(`ERR ${label} ${Date.now() - t0}ms ::`, e.message)
  }
}

;(async () => {
  await testHttps('ipwho.is      ', 'ipwho.is', '/')
  await testHttps('ipapi.co/json ', 'ipapi.co', '/json/')
  await testHttps('ipify(geo)    ', 'api.ipify.org', '/?format=json')
})()
