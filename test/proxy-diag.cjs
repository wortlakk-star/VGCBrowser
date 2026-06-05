const { SocksClient } = require('socks')
const tls = require('tls')

async function testHttps(label, host, path) {
  const t0 = Date.now()
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: '185.123.152.138', port: 12324, type: 5, userId: '14a5942224c26', password: '67e3731d01' },
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
