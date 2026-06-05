// ── VGC Browser — proxy checker ──────────────────────────────────────────────
// Probes a proxy by fetching a geo/IP endpoint THROUGH it over HTTPS (port 443).
// HTTPS is used (not plain HTTP) because many residential/datacenter proxies
// BLOCK port 80 — checking over 80 (old ip-api) timed out for those. We tunnel
// to ipwho.is:443 (SOCKS5 → socks socket; HTTP proxy → CONNECT tunnel), wrap with
// TLS, and parse the JSON (ip, country, countryCode, city, timezone, lat/lon).

import http from 'http'
import net from 'net'
import tls from 'tls'
import { SocksClient } from 'socks'
import type { ProxyConfig, ProxyCheckResult } from '../shared/types'

const GEO_HOST = 'ipwho.is'
const GEO_PATH = '/'

/** Hard overall cap so a half-open proxy socket can't hang the check forever. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Proxy timeout')), ms))
  ])
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

/** SOCKS5: open a tunnel to GEO_HOST:443 and return the raw socket. */
async function socksSocket(proxy: ProxyConfig): Promise<net.Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: { host: proxy.host!, port: proxy.port!, type: 5, userId: proxy.username, password: proxy.password },
    command: 'connect',
    destination: { host: GEO_HOST, port: 443 },
    timeout: 9000
  })
  return socket
}

/** HTTP/HTTPS proxy: CONNECT-tunnel to GEO_HOST:443 and return the tunneled socket. */
function connectSocket(proxy: ProxyConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${GEO_HOST}:443` }
    if (proxy.username) {
      const token = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')
      headers['Proxy-Authorization'] = `Basic ${token}`
    }
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${GEO_HOST}:443`,
      headers,
      timeout: 9000
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

/** TLS over the tunneled socket, send an HTTPS GET, return the raw response. */
function httpsOver(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: GEO_HOST, rejectUnauthorized: false }, () => {
      t.write(
        `GET ${GEO_PATH} HTTP/1.1\r\nHost: ${GEO_HOST}\r\nUser-Agent: Mozilla/5.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`
      )
    })
    let data = ''
    t.setEncoding('utf8')
    t.setTimeout(9000, () => t.destroy(new Error('Proxy timeout')))
    t.on('data', (d) => (data += d))
    t.on('end', () => resolve(data))
    t.on('close', () => resolve(data))
    t.on('timeout', () => t.destroy(new Error('Proxy timeout')))
    t.on('error', reject)
  })
}

export async function checkProxy(proxy: ProxyConfig): Promise<ProxyCheckResult> {
  if (proxy.type === 'none' || !proxy.host || !proxy.port) {
    return { ok: false, error: 'Chưa cấu hình proxy' }
  }
  const t0 = Date.now()
  try {
    const socket = proxy.type === 'socks5' ? await socksSocket(proxy) : await connectSocket(proxy)
    const raw = await withTimeout(httpsOver(socket), 12000)
    const latencyMs = Date.now() - t0
    const j = extractJson(raw)
    if (!j) return { ok: false, error: 'Không đọc được phản hồi geo', latencyMs }
    if (j.success === false) {
      return { ok: false, error: String(j.message ?? 'Proxy/Geo lỗi'), latencyMs }
    }
    const tz =
      j.timezone && typeof j.timezone === 'object'
        ? String((j.timezone as Record<string, unknown>).id ?? '')
        : String(j.timezone ?? '')
    return {
      ok: true,
      ip: String(j.ip ?? ''),
      country: String(j.country ?? ''),
      countryCode: String(j.country_code ?? ''),
      city: String(j.city ?? ''),
      timezone: tz,
      latitude: typeof j.latitude === 'number' ? j.latitude : undefined,
      longitude: typeof j.longitude === 'number' ? j.longitude : undefined,
      latencyMs
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - t0 }
  }
}
