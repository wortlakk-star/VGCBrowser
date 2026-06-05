// ── VGC Browser — local proxy relay ──────────────────────────────────────────
// Chromium's `--proxy-server` flag cannot carry a username/password, and it
// can't do SOCKS5 auth at all. So for authenticated (or SOCKS5-auth) proxies we
// spin up a tiny local HTTP proxy on 127.0.0.1 and point Chromium at it; the
// relay forwards upstream and injects the credentials. One relay per running
// profile, torn down on exit.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { connect as netConnect } from 'net'
import type { Duplex } from 'stream'
import { SocksClient } from 'socks'
import type { ProxyConfig } from '../shared/types'

export interface RelayHandle {
  port: number
  close: () => void
}

/** Chromium handles no-auth http/https/socks5 itself; only relay when it can't. */
export function proxyNeedsRelay(p: ProxyConfig): boolean {
  if (p.type === 'none' || !p.host || !p.port) return false
  return Boolean(p.username) // any proxy with auth needs the relay
}

function basicAuth(p: ProxyConfig): string {
  if (!p.username) return ''
  const token = Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')
  return `Proxy-Authorization: Basic ${token}\r\n`
}

// ── HTTPS tunneling (CONNECT) — the common path ──
function handleConnect(proxy: ProxyConfig, req: IncomingMessage, client: Duplex, head: Buffer): void {
  const [host, portStr] = (req.url ?? '').split(':')
  const port = Number(portStr) || 443

  const fail = (): void => {
    try {
      client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    } catch {
      /* ignore */
    }
    try {
      client.end()
    } catch {
      /* ignore */
    }
  }

  if (proxy.type === 'socks5') {
    SocksClient.createConnection({
      proxy: {
        host: proxy.host!,
        port: proxy.port!,
        type: 5,
        userId: proxy.username,
        password: proxy.password
      },
      command: 'connect',
      destination: { host, port }
    })
      .then(({ socket }) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) socket.write(head)
        socket.pipe(client)
        client.pipe(socket)
        socket.on('error', fail)
      })
      .catch(fail)
    return
  }

  // http/https upstream proxy → forward CONNECT with credentials.
  const upstream = netConnect(proxy.port!, proxy.host!, () => {
    upstream.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
        basicAuth(proxy) +
        'Proxy-Connection: keep-alive\r\n\r\n'
    )
  })

  let buf = Buffer.alloc(0)
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    const idx = buf.indexOf('\r\n\r\n')
    if (idx === -1) return
    upstream.removeListener('data', onData)
    const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1')
    if (!/ 200 /.test(statusLine)) {
      fail()
      upstream.end()
      return
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const remainder = buf.slice(idx + 4)
    if (head && head.length) upstream.write(head)
    if (remainder.length) client.write(remainder)
    upstream.pipe(client)
    client.pipe(upstream)
  }
  upstream.on('data', onData)
  upstream.on('error', fail)
  client.on('error', () => {
    try {
      upstream.end()
    } catch {
      /* ignore */
    }
  })
}

// ── Plain HTTP forwarding (http:// sites) ──
function handleHttp(proxy: ProxyConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? ''
  const fail = (): void => {
    try {
      res.writeHead(502)
      res.end('relay error')
    } catch {
      /* ignore */
    }
  }

  if (proxy.type === 'socks5') {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      fail()
      return
    }
    const port = Number(u.port) || 80
    SocksClient.createConnection({
      proxy: { host: proxy.host!, port: proxy.port!, type: 5, userId: proxy.username, password: proxy.password },
      command: 'connect',
      destination: { host: u.hostname, port }
    })
      .then(({ socket }) => {
        const headers = Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n')
        socket.write(`${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n${headers}\r\n\r\n`)
        req.pipe(socket)
        socket.pipe(res.socket!)
        socket.on('error', fail)
      })
      .catch(fail)
    return
  }

  // http/https upstream proxy: replay the absolute-URI request with credentials.
  const upstream = netConnect(proxy.port!, proxy.host!, () => {
    const auth = basicAuth(proxy)
    const headers = Object.entries(req.headers)
      .filter(([k]) => k.toLowerCase() !== 'proxy-authorization')
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n')
    upstream.write(`${req.method} ${url} HTTP/1.1\r\n${headers}\r\n${auth}\r\n`)
    req.pipe(upstream)
  })
  upstream.pipe(res.socket!)
  upstream.on('error', fail)
}

export async function startRelay(proxy: ProxyConfig): Promise<RelayHandle> {
  const server = createServer()
  server.on('request', (req, res) => handleHttp(proxy, req, res))
  server.on('connect', (req, socket, head) => handleConnect(proxy, req as IncomingMessage, socket, head))
  server.on('clientError', (_e, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      /* ignore */
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    port,
    close: () => {
      try {
        server.close()
      } catch {
        /* ignore */
      }
    }
  }
}
