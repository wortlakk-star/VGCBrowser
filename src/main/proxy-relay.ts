// ── VGC Browser — local proxy relay ──────────────────────────────────────────
// Chromium's `--proxy-server` flag cannot carry a username/password, and it
// can't do SOCKS5 auth at all. So for authenticated (or SOCKS5-auth) proxies we
// spin up a tiny local HTTP proxy on 127.0.0.1 and point Chromium at it; the
// relay forwards upstream and injects the credentials. One relay per running
// profile, torn down on exit.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { connect as netConnect, isIP, type Socket } from 'net'
import { connect as tlsConnect } from 'tls'
import type { Duplex } from 'stream'
import { SocksClient } from 'socks'
import type { ProxyConfig } from '../shared/types'
import { sanitizeProxyConfig } from './validation'

const MAX_UPSTREAM_HEADER = 64 * 1024
const SOCKET_TIMEOUT = 30_000
const MAX_RELAY_CONNECTIONS = 256

function connectTarget(raw: string): { host: string; port: number } | null {
  try {
    const url = new URL(`http://${raw}`)
    const port = Number(url.port || 443)
    if (!url.hostname || url.username || url.password || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null
    }
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
  } catch {
    return null
  }
}

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

/**
 * One-way pipe that can't crash the app. When a peer (browser tab or upstream
 * proxy) closes mid-transfer, the next write throws EPIPE/ECONNRESET; with no
 * 'error' listener on that stream Node escalates it to an uncaught exception —
 * the "A JavaScript error occurred in the main process" dialog. Attaching error
 * listeners to BOTH ends and tearing the pair down keeps the blip contained.
 */
function safePipe(src: NodeJS.ReadableStream, dst: NodeJS.WritableStream): void {
  const onErr = (): void => {
    ;(src as Partial<Duplex>).destroy?.()
    ;(dst as Partial<Duplex>).destroy?.()
  }
  src.once('error', onErr)
  dst.once('error', onErr)
  src.pipe(dst)
}

function connectUpstream(proxy: ProxyConfig, connected: () => void): Socket {
  if (proxy.type === 'https') {
    return tlsConnect(
      {
        host: proxy.host!,
        port: proxy.port!,
        servername: isIP(proxy.host!) ? undefined : proxy.host!,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['http/1.1']
      },
      connected
    )
  }
  return netConnect(proxy.port!, proxy.host!, connected)
}

function requestHeaders(req: IncomingMessage, targetHost: string): string | null {
  const lines = Object.entries(req.headers)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        !['host', 'proxy-authorization', 'proxy-connection', 'connection'].includes(
          key.toLowerCase()
        )
    )
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
  lines.unshift(`Host: ${targetHost}`)
  lines.push('Connection: close')
  const headers = lines.join('\r\n')
  return Buffer.byteLength(headers, 'latin1') <= MAX_UPSTREAM_HEADER ? headers : null
}

// ── HTTPS tunneling (CONNECT) — the common path ──
function handleConnect(proxy: ProxyConfig, req: IncomingMessage, client: Duplex, head: Buffer): void {
  const target = connectTarget(req.url ?? '')
  let upstream: Socket | null = null
  let established = false
  let failed = false

  const fail = (): void => {
    if (failed) return
    failed = true
    upstream?.destroy()
    try {
      if (!established) client.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    } catch {
      /* ignore */
    }
    try {
      client.end()
    } catch {
      /* ignore */
    }
  }

  if (!target || head.length > MAX_UPSTREAM_HEADER) {
    fail()
    return
  }
  const { host, port } = target
  ;(client as import('net').Socket).setTimeout(SOCKET_TIMEOUT, () => client.destroy())

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
      destination: { host, port },
      timeout: SOCKET_TIMEOUT
    })
      .then(({ socket }) => {
        if (failed || client.destroyed) {
          socket.destroy()
          return
        }
        upstream = socket
        socket.setTimeout(SOCKET_TIMEOUT, fail)
        established = true
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) socket.write(head)
        safePipe(socket, client)
        safePipe(client, socket)
      })
      .catch(fail)
    return
  }

  // http/https upstream proxy → forward CONNECT with credentials.
  const relay = connectUpstream(proxy, () => {
    if (failed) return
    relay.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
        basicAuth(proxy) +
        'Proxy-Connection: keep-alive\r\n\r\n'
    )
  })
  upstream = relay
  relay.setTimeout(SOCKET_TIMEOUT, fail)

  let buf = Buffer.alloc(0)
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length > MAX_UPSTREAM_HEADER) {
      fail()
      return
    }
    const idx = buf.indexOf('\r\n\r\n')
    if (idx === -1) return
    relay.removeListener('data', onData)
    const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1')
    if (!/^HTTP\/1\.[01] 2\d\d(?: |$)/.test(statusLine)) {
      fail()
      return
    }
    established = true
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const remainder = buf.slice(idx + 4)
    if (head && head.length) relay.write(head)
    if (remainder.length) client.write(remainder)
    safePipe(relay, client)
    safePipe(client, relay)
  }
  relay.on('data', onData)
  relay.on('error', fail)
  client.on('error', () => upstream?.destroy())
  client.on('close', () => upstream?.destroy())
}

// ── Plain HTTP forwarding (http:// sites) ──
function handleHttp(proxy: ProxyConfig, req: IncomingMessage, res: ServerResponse): void {
  let target: URL
  try {
    target = new URL(req.url ?? '')
    if (target.protocol !== 'http:' || target.username || target.password) {
      throw new Error('invalid relay URL')
    }
    target.hash = ''
  } catch {
    res.writeHead(400)
    res.end('invalid proxy request')
    return
  }
  let upstream: Socket | null = null
  let failed = false
  const fail = (): void => {
    if (failed) return
    failed = true
    upstream?.destroy()
    try {
      res.writeHead(502)
      res.end('relay error')
    } catch {
      /* ignore */
    }
  }

  if (proxy.type === 'socks5') {
    const port = Number(target.port) || 80
    const headers = requestHeaders(req, target.host)
    if (!headers) {
      fail()
      return
    }
    SocksClient.createConnection({
      proxy: { host: proxy.host!, port: proxy.port!, type: 5, userId: proxy.username, password: proxy.password },
      command: 'connect',
      destination: { host: target.hostname, port },
      timeout: SOCKET_TIMEOUT
    })
      .then(({ socket }) => {
        if (failed || res.destroyed) {
          socket.destroy()
          return
        }
        upstream = socket
        socket.setTimeout(SOCKET_TIMEOUT, () => socket.destroy())
        socket.write(
          `${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers}\r\n\r\n`
        )
        safePipe(req, socket)
        if (res.socket) safePipe(socket, res.socket)
        socket.on('error', fail)
      })
      .catch(fail)
    return
  }

  // http/https upstream proxy: replay the absolute-URI request with credentials.
  const headers = requestHeaders(req, target.host)
  if (!headers) {
    fail()
    return
  }
  upstream = connectUpstream(proxy, () => {
    if (!upstream || failed) return
    const auth = basicAuth(proxy)
    upstream.write(`${req.method} ${target.href} HTTP/1.1\r\n${headers}\r\n${auth}\r\n`)
    safePipe(req, upstream)
  })
  upstream.setTimeout(SOCKET_TIMEOUT, fail)
  if (res.socket) safePipe(upstream, res.socket)
  upstream.on('error', fail)
  req.on('aborted', () => upstream?.destroy())
}

export async function startRelay(proxy: ProxyConfig): Promise<RelayHandle> {
  const safeProxy = sanitizeProxyConfig(proxy)
  if (safeProxy.type === 'none' || !safeProxy.host || !safeProxy.port) throw new Error('Proxy relay không hợp lệ')
  const server = createServer()
  const clients = new Set<Socket>()
  server.maxConnections = MAX_RELAY_CONNECTIONS
  server.headersTimeout = 15_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 10_000
  server.maxHeadersCount = 100
  server.on('request', (req, res) => handleHttp(safeProxy, req, res))
  server.on('connect', (req, socket, head) => handleConnect(safeProxy, req as IncomingMessage, socket, head))
  server.on('connection', (socket) => {
    if (socket.remoteAddress !== '127.0.0.1') {
      socket.destroy()
      return
    }
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
  })
  server.on('clientError', (_e, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      /* ignore */
    }
  })
  // Keep a permanent listener so a late accept/listen error cannot become an
  // uncaught EventEmitter error in Electron's main process.
  server.on('error', () => {})

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    port,
    close: () => {
      for (const socket of clients) socket.destroy()
      clients.clear()
      try {
        server.close()
      } catch {
        /* ignore */
      }
    }
  }
}
