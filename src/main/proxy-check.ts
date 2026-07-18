// ── VGC Browser — proxy checker ──────────────────────────────────────────────
// Probes a proxy by fetching a geo/IP endpoint THROUGH it over HTTPS (port 443).
// HTTPS is used (not plain HTTP) because many residential/datacenter proxies BLOCK
// port 80. We tunnel to the geo host:443 (SOCKS5 → socks socket; HTTP proxy → CONNECT
// tunnel), wrap with TLS, and parse the JSON.
//
// RELIABILITY (why the check used to flap "alive/dead"):
//   • It tried ONCE — a single transient hiccup on a residential/mobile proxy (which
//     have ~1.5s+ latency and occasional resets) marked a live proxy dead.
//   • It used ONE geo endpoint (ipwho.is) whose free tier RATE-LIMITS bursts — checking
//     many proxies at once made ipwho.is throttle → live proxies looked dead.
//   • It conflated "proxy tunnel failed" (really dead) with "geo lookup failed" (proxy
//     fine, endpoint hiccup) → false negatives.
// Fixes here: retry a few times, ROTATE across two independent geo providers, and — most
// importantly — treat a SUCCESSFUL TUNNEL as alive even when the geo body can't be read.

import http from 'http'
import net from 'net'
import tls from 'tls'
import { SocksClient } from 'socks'
import type { ProxyConfig, ProxyCheckResult } from '../shared/types'

interface GeoProvider {
  host: string
  path: string
  parse: (j: Record<string, unknown>) => Partial<ProxyCheckResult> | null
}

// Two independent providers → if one rate-limits, the other still answers. Both serve
// JSON over 443. We normalize their different shapes to the same result fields.
const GEO_PROVIDERS: GeoProvider[] = [
  {
    host: 'ipwho.is',
    path: '/',
    parse: (j) => {
      if (j.success === false || !j.ip) return null
      const tzRaw = j.timezone
      const tz =
        tzRaw && typeof tzRaw === 'object'
          ? String((tzRaw as Record<string, unknown>).id ?? '')
          : String(tzRaw ?? '')
      return {
        ip: String(j.ip),
        country: String(j.country ?? ''),
        countryCode: String(j.country_code ?? ''),
        city: String(j.city ?? ''),
        timezone: tz,
        latitude: typeof j.latitude === 'number' ? j.latitude : undefined,
        longitude: typeof j.longitude === 'number' ? j.longitude : undefined
      }
    }
  },
  {
    host: 'ipinfo.io',
    path: '/json',
    parse: (j) => {
      if (!j.ip) return null
      const loc = typeof j.loc === 'string' ? j.loc.split(',') : []
      const cc = String(j.country ?? '') // ipinfo returns a 2-letter code
      return {
        ip: String(j.ip),
        country: cc,
        countryCode: cc,
        city: String(j.city ?? ''),
        timezone: String(j.timezone ?? ''),
        latitude: loc[0] ? Number(loc[0]) : undefined,
        longitude: loc[1] ? Number(loc[1]) : undefined
      }
    }
  }
]

const CONNECT_TIMEOUT = 12000
const READ_TIMEOUT = 12000
const ATTEMPTS = 3

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Hard overall cap so a half-open proxy socket can't hang the check forever. Clears the
 *  timer once the race settles so a fast-resolving check doesn't leave a live 12s timer per
 *  call (batch checks would otherwise pile up dozens of dangling timers). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>
  const timer = new Promise<T>((_, reject) => {
    id = setTimeout(() => reject(new Error('Proxy timeout')), ms)
  })
  return Promise.race([p, timer]).finally(() => clearTimeout(id))
}

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** SOCKS5: open a tunnel to host:port and return the raw socket. */
async function socksTunnel(proxy: ProxyConfig, host: string, port: number): Promise<net.Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.host!,
      port: proxy.port!,
      type: 5,
      userId: proxy.username,
      password: proxy.password
    },
    command: 'connect',
    destination: { host, port },
    timeout: CONNECT_TIMEOUT
  })
  return socket
}

/** HTTP/HTTPS proxy: CONNECT-tunnel to host:port and return the tunneled socket. */
function connectTunnel(proxy: ProxyConfig, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${host}:${port}` }
    if (proxy.username) {
      const token = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')
      headers['Proxy-Authorization'] = `Basic ${token}`
    }
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout: CONNECT_TIMEOUT
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`Proxy CONNECT lỗi ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Proxy timeout')))
    req.end()
  })
}

function tunnelTo(proxy: ProxyConfig, host: string, port: number): Promise<net.Socket> {
  return proxy.type === 'socks5' ? socksTunnel(proxy, host, port) : connectTunnel(proxy, host, port)
}

/**
 * Keep-alive poke: open a tunnel THROUGH the proxy to a stable host, then close it
 * immediately. The upstream connect routes through the residential peer, so the sticky
 * (Evomi hardsession) session registers activity and isn't recycled for inactivity —
 * while transferring ≈no payload (residential proxies are GB-metered, so we deliberately
 * send nothing beyond the tunnel setup). Returns whether the tunnel opened. Never throws.
 */
export async function pokeProxy(proxy: ProxyConfig): Promise<boolean> {
  const tunnel = tunnelTo(proxy, 'www.google.com', 443)
  let timedOut = false
  // If withTimeout's timer wins the race, tunnelTo can still resolve a live socket a moment
  // later that nobody awaits — destroy that orphan so periodic keep-alive pokes don't leak
  // sockets. (Also swallow a late rejection so it isn't an unhandled rejection.)
  tunnel.then(
    (s) => {
      if (timedOut) {
        try {
          s.destroy()
        } catch {
          /* best effort */
        }
      }
    },
    () => {}
  )
  let socket: net.Socket | null = null
  try {
    socket = await withTimeout(tunnel, CONNECT_TIMEOUT)
    return true
  } catch {
    timedOut = true
    return false
  } finally {
    try {
      socket?.destroy()
    } catch {
      // ignore — best effort
    }
  }
}

/** TLS over the tunneled socket, send an HTTPS GET, return the raw response. */
function httpsOver(socket: net.Socket, host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
      t.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`
      )
    })
    let data = ''
    t.setEncoding('utf8')
    t.setTimeout(READ_TIMEOUT, () => t.destroy(new Error('Proxy timeout')))
    t.on('data', (d) => (data += d))
    t.on('end', () => resolve(data))
    t.on('close', () => resolve(data))
    t.on('timeout', () => t.destroy(new Error('Proxy timeout')))
    t.on('error', reject)
  })
}

/**
 * Geo of the DIRECT (no-proxy) connection = the machine's real public IP. Used to keep a
 * NO-PROXY profile's timezone/locale/geolocation coherent with the real IP. Tries the geo
 * providers in order so a single endpoint's rate-limit doesn't fail the whole thing.
 */
export async function directGeo(): Promise<ProxyCheckResult> {
  const t0 = Date.now()
  for (const gp of GEO_PROVIDERS) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(`https://${gp.host}${gp.path}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' }
      }).finally(() => clearTimeout(timer))
      const j = (await res.json()) as Record<string, unknown>
      const parsed = gp.parse(j)
      if (parsed?.ip) return { ok: true, ...parsed, latencyMs: Date.now() - t0 }
    } catch {
      // try the next provider
    }
  }
  return { ok: false, error: 'geo lỗi', latencyMs: Date.now() - t0 }
}

export async function checkProxy(proxy: ProxyConfig): Promise<ProxyCheckResult> {
  if (proxy.type === 'none' || !proxy.host || !proxy.port) {
    return { ok: false, error: 'Chưa cấu hình proxy' }
  }
  const t0 = Date.now()
  let tunnelConnected = false
  let lastErr = 'Không kết nối được proxy'

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // Rotate providers across attempts so a rate-limited endpoint gets a different one
    // on the retry (attempt 0 → ipwho.is, 1 → ipinfo.io, 2 → ipwho.is).
    const gp = GEO_PROVIDERS[attempt % GEO_PROVIDERS.length]
    let socket: net.Socket
    try {
      socket = await tunnelTo(proxy, gp.host, 443)
      tunnelConnected = true // the proxy accepted a tunnel → it is ALIVE
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      await sleep(300)
      continue
    }
    try {
      const raw = await withTimeout(httpsOver(socket, gp.host, gp.path), READ_TIMEOUT)
      const j = extractJson(raw)
      const parsed = j ? gp.parse(j) : null
      if (parsed?.ip) return { ok: true, ...parsed, latencyMs: Date.now() - t0 }
      lastErr = 'Không đọc được phản hồi geo'
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    }
    await sleep(300)
  }

  // A tunnel succeeded at least once → the proxy WORKS; only the geo lookup failed
  // (rate-limit / provider hiccup). Report alive so a working proxy is never flagged dead.
  if (tunnelConnected) return { ok: true, latencyMs: Date.now() - t0 }
  return { ok: false, error: lastErr, latencyMs: Date.now() - t0 }
}
