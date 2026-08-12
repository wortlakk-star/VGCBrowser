// ── VGC Browser — proxy relay verification (fully local, no external network) ──
// Stands up: a fake AUTH-required upstream HTTP proxy + a local "origin" TCP
// server, then drives our relay through it. Proves: (1) the relay injects
// upstream credentials and tunnels CONNECT to the origin; (2) wrong credentials
// are rejected (502).
//
// Build+run:  npx esbuild test/verify-relay.ts --bundle --platform=node
//               --format=cjs --outfile=test/relay.cjs && node test/relay.cjs

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(data)
    }
    sock.setEncoding('utf8')
    sock.on('data', (d) => {
      data += d
      if (data.includes(BANNER) || data.includes('502')) finish()
    })
    sock.on('error', reject)
    const timer = setTimeout(finish, 4000)
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

  // A self-signed HTTPS proxy lets us prove the relay actually performs TLS and
  // refuses an untrusted upstream certificate instead of silently using plaintext.
  const certDir = mkdtempSync(join(tmpdir(), 'vgc-relay-cert-'))
  const keyPath = join(certDir, 'key.pem')
  const certPath = join(certDir, 'cert.pem')
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath],
    { stdio: 'ignore' }
  )
  const tlsUpstream = https.createServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certPath)
  })
  let tlsHandshakeSeen = false
  tlsUpstream.on('tlsClientError', () => {
    tlsHandshakeSeen = true
  })
  const tlsUpstreamPort = await listen(tlsUpstream)

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

  // 3. HTTPS means TLS-to-proxy, with normal CA/hostname verification enabled.
  const untrustedTls = await startRelay({
    type: 'https',
    host: 'localhost',
    port: tlsUpstreamPort,
    username: USER,
    password: PASS
  })
  const r3 = await connectViaRelay(untrustedTls.port, `127.0.0.1:${originPort}`)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const ok3 = r3.includes('502') && tlsHandshakeSeen && !r3.includes(BANNER)
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  untrusted HTTPS proxy rejected`)
  if (ok3) pass++
  untrustedTls.close()

  origin.close()
  upstream.close()
  tlsUpstream.close()
  rmSync(certDir, { recursive: true, force: true })
  console.log(`\n${pass}/3 checks passed.`)
  process.exitCode = pass === 3 ? 0 : 1
}

main().catch((e) => {
  console.error('relay verify error:', e)
  process.exitCode = 2
})
