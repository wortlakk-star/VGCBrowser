// ── VGC Browser — proxy relay verification (fully local, no external network) ──
// Stands up: a fake AUTH-required upstream HTTP proxy + a local "origin" TCP
// server, then drives our relay through it. Proves: (1) the relay injects
// upstream credentials and tunnels CONNECT to the origin; (2) wrong credentials
// are rejected (502).
//
// Build+run:  npx esbuild test/verify-relay.ts --bundle --platform=node
//               --format=cjs --outfile=test/relay.cjs && node test/relay.cjs

import http from 'node:http'
import net from 'node:net'
import { startRelay } from '../src/main/proxy-relay'

const USER = 'vgc'
const PASS = 's3cret'
const BANNER = 'HELLO-ORIGIN'

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

function connectViaRelay(relayPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(relayPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let data = ''
    sock.setEncoding('utf8')
    sock.on('data', (d) => {
      data += d
      if (data.includes(BANNER) || data.includes('502')) {
        sock.end()
        resolve(data)
      }
    })
    sock.on('error', reject)
    setTimeout(() => {
      sock.end()
      resolve(data)
    }, 4000)
  })
}

async function main(): Promise<void> {
  // Local origin: greets every connection with a banner.
  const origin = net.createServer((s) => s.write(BANNER))
  const originPort = await listen(origin)

  // Fake upstream proxy requiring Basic auth.
  const upstream = http.createServer()
  upstream.on('connect', (req, clientSocket, head) => {
    const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
    if (req.headers['proxy-authorization'] !== expected) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      clientSocket.end()
      return
    }
    const [host, portStr] = (req.url ?? '').split(':')
    const up = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(clientSocket)
      clientSocket.pipe(up)
    })
    up.on('error', () => clientSocket.end())
  })
  const upstreamPort = await listen(upstream)

  console.log('\n=== VGC relay verification ===')
  let pass = 0

  // 1. Correct credentials → tunnel succeeds, banner arrives.
  const good = await startRelay({
    type: 'http',
    host: '127.0.0.1',
    port: upstreamPort,
    username: USER,
    password: PASS
  })
  const r1 = await connectViaRelay(good.port, `127.0.0.1:${originPort}`)
  const ok1 = r1.includes('200 Connection Established') && r1.includes(BANNER)
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  auth tunnel: ${JSON.stringify(r1.slice(0, 60))}`)
  if (ok1) pass++
  good.close()

  // 2. Wrong credentials → relay reports 502 (upstream 407 → relay fails).
  const bad = await startRelay({
    type: 'http',
    host: '127.0.0.1',
    port: upstreamPort,
    username: USER,
    password: 'WRONG'
  })
  const r2 = await connectViaRelay(bad.port, `127.0.0.1:${originPort}`)
  const ok2 = r2.includes('502') && !r2.includes(BANNER)
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  bad-auth rejected: ${JSON.stringify(r2.slice(0, 60))}`)
  if (ok2) pass++
  bad.close()

  origin.close()
  upstream.close()
  console.log(`\n${pass}/2 checks passed.`)
  process.exitCode = pass === 2 ? 0 : 1
}

main().catch((e) => {
  console.error('relay verify error:', e)
  process.exitCode = 2
})
