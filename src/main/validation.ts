import { isIP } from 'net'
import type { Cookie, Profile, ProxyConfig, SavedProxy } from '../shared/types'
import { randomUUID } from 'crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function requireUuid(value: unknown, label = 'ID'): string {
  if (!isUuid(value)) throw new Error(`${label} không hợp lệ`)
  return value
}

export function requireProfileId(value: unknown): string {
  return requireUuid(value, 'Profile ID')
}

export function requireProfileIds(value: unknown, max = 500): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Danh sách profile không hợp lệ')
  return [...new Set(value.map(requireProfileId))]
}

export function requireTokenId(value: unknown, label = 'ID'): string {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(value)) {
    throw new Error(`${label} không hợp lệ`)
  }
  return value
}

export function requireTokenIds(value: unknown, max = 10_000): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Danh sách ID không hợp lệ')
  return [...new Set(value.map((item) => requireTokenId(item)))]
}

export function cleanText(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max)
    : ''
}

export function sanitizeStartUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value.slice(0, 20)) {
    if (typeof raw !== 'string' || raw.length > 2048 || raw.startsWith('--')) continue
    try {
      const url = new URL(raw)
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
        out.push(url.toString())
      }
    } catch {
      // Ignore malformed or command-line-like values.
    }
  }
  return [...new Set(out)]
}

export function sanitizeProxyConfig(value: unknown): ProxyConfig {
  if (!value || typeof value !== 'object') return { type: 'none' }
  const input = value as Partial<ProxyConfig>
  if (input.type === 'none') return { type: 'none' }
  const type = input.type
  if (type !== 'http' && type !== 'https' && type !== 'socks5') return { type: 'none' }
  let host = cleanText(input.host, 253).trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const port = Number(input.port)
  if (
    (!isIP(host) && !HOST_RE.test(host)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return { type: 'none' }
  }
  const username = cleanText(input.username, 512)
  const password = cleanText(input.password, 2048)
  const provider = cleanText(input.provider, 80)
  return {
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(provider ? { provider } : {})
  }
}

export function sanitizeSavedProxy(value: unknown): SavedProxy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<SavedProxy>
  const config = sanitizeProxyConfig(input)
  if (config.type === 'none' || !config.host || !config.port) return null
  const id =
    typeof input.id === 'string' && /^[a-z0-9_-]{1,100}$/i.test(input.id)
      ? input.id
      : randomUUID()
  const updatedAt =
    typeof input.updatedAt === 'string' && Number.isFinite(Date.parse(input.updatedAt))
      ? new Date(input.updatedAt).toISOString()
      : undefined
  const latency = Number(input.latencyMs)
  return {
    id,
    label: cleanText(input.label, 160).trim() || `${config.host}:${config.port}`,
    type: config.type,
    host: config.host,
    port: config.port,
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
    ...(isUuid(input.assignedTo) ? { assignedTo: input.assignedTo } : {}),
    ...(typeof input.lastIp === 'string' ? { lastIp: cleanText(input.lastIp, 64) } : {}),
    ...(typeof input.lastCountry === 'string' ? { lastCountry: cleanText(input.lastCountry, 120) } : {}),
    ...(typeof input.lastCountryCode === 'string'
      ? { lastCountryCode: cleanText(input.lastCountryCode, 2).toUpperCase() }
      : {}),
    ...(Number.isFinite(latency) ? { latencyMs: Math.max(0, Math.min(300_000, latency)) } : {}),
    ...(input.lastStatus === 'ok' || input.lastStatus === 'error' ? { lastStatus: input.lastStatus } : {}),
    ...(updatedAt ? { updatedAt } : {})
  }
}

export function sanitizeCookies(value: unknown): Cookie[] {
  if (!Array.isArray(value)) return []
  const out: Cookie[] = []
  for (const raw of value.slice(0, 10_000)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<Cookie>
    const name = cleanText(item.name, 1024)
    const domain = cleanText(item.domain, 255).trim()
    if (!name || !domain || /[\s/\\]/.test(domain)) continue
    const path = cleanText(item.path, 2048) || '/'
    const expires = Number(item.expires)
    out.push({
      name,
      value: cleanText(item.value, 64 * 1024),
      domain,
      path: path.startsWith('/') ? path : '/',
      ...(Number.isFinite(expires) ? { expires } : {}),
      httpOnly: item.httpOnly === true,
      secure: item.secure === true,
      ...(['Strict', 'Lax', 'None'].includes(String(item.sameSite))
        ? { sameSite: item.sameSite as Cookie['sameSite'] }
        : {})
    })
  }
  return out
}

export function sanitizeAccount(value: unknown): Profile['account'] {
  if (!value || typeof value !== 'object') return undefined
  const item = value as NonNullable<Profile['account']>
  const status = ['live', 'die', 'banned', 'ready'].includes(String(item.status))
    ? item.status
    : undefined
  const user = cleanText(item.user, 320).trim()
  const pass = cleanText(item.pass, 2048)
  const totp = cleanText(item.totp, 256).replace(/\s+/g, '')
  return user || pass || totp || status
    ? { ...(user ? { user } : {}), ...(pass ? { pass } : {}), ...(totp ? { totp } : {}), ...(status ? { status } : {}) }
    : undefined
}

export function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((tag) => cleanText(tag, 64).trim()).filter(Boolean))].slice(0, 50)
}

export function sanitizeExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((path) => cleanText(path, 2048)).filter(Boolean))].slice(0, 50)
}

export function normalizeSupabaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null
  try {
    const url = new URL(value.trim())
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function trustedExternalUrl(value: unknown, allowedHosts?: ReadonlySet<string>): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    if (allowedHosts && !allowedHosts.has(url.hostname.toLowerCase())) return null
    return url.toString()
  } catch {
    return null
  }
}
