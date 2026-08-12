// ── VGC Browser — proxy provider connectors ─────────────────────────────────
// Store account credentials for IPRoyal / Oxylabs / Bright Data (per cloud
// account) and build a ready-to-use proxy connection (gateway host:port +
// username encoding country/session) — like GoLogin's "connect proxy provider".
// The provider "API" for residential pools is the gateway: routing is done by
// formatting the username/password; no per-request API call is needed to use it.

import { app } from 'electron'
import { join } from 'path'
import { accountKey } from './session'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'
import type {
  ProxyConfig,
  ProxyProviderId,
  ProviderCreds,
  ProxyBuildOpts,
  GenerateProxiesOpts,
  SavedProxy
} from '../shared/types'
import { cleanText, sanitizeProxyConfig } from './validation'
import { randomBytes, randomUUID } from 'crypto'
import { readLimitedResponseJson, readLimitedResponseText } from './http-limit'

const MAX_PROVIDER_RESPONSE = 2 * 1024 * 1024
const PROVIDERS = new Set<ProxyProviderId>([
  'iproyal',
  'oxylabs',
  'brightdata',
  'evomi',
  'cliproxy'
])

function credential(value: unknown, max = 4096): string {
  return cleanText(value, max).replace(/[\r\n\t]/g, '').trim()
}

function normalizeCreds(value: unknown): ProviderCreds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as ProviderCreds
  const clipPort = Number(input.cliproxy?.port)
  return {
    ...(input.iproyal
      ? { iproyal: {
          username: credential(input.iproyal.username, 512),
          password: credential(input.iproyal.password, 2048),
          ...(input.iproyal.apiToken ? { apiToken: credential(input.iproyal.apiToken) } : {})
        } }
      : {}),
    ...(input.oxylabs
      ? { oxylabs: { username: credential(input.oxylabs.username, 512), password: credential(input.oxylabs.password, 2048) } }
      : {}),
    ...(input.brightdata
      ? { brightdata: {
          customer: credential(input.brightdata.customer, 512),
          zone: credential(input.brightdata.zone, 512),
          password: credential(input.brightdata.password, 2048)
        } }
      : {}),
    ...(input.evomi ? { evomi: { apiKey: credential(input.evomi.apiKey) } } : {}),
    ...(input.cliproxy
      ? { cliproxy: {
          host: credential(input.cliproxy.host, 253),
          port: Number.isInteger(clipPort) && clipPort > 0 && clipPort <= 65535 ? clipPort : undefined,
          username: credential(input.cliproxy.username, 512),
          password: credential(input.cliproxy.password, 2048),
          state: credential(input.cliproxy.state, 80)
        } }
      : {})
  }
}

async function limitedText(response: Response): Promise<string> {
  return readLimitedResponseText(response, MAX_PROVIDER_RESPONSE)
}

async function limitedJson<T>(response: Response): Promise<T> {
  return readLimitedResponseJson<T>(response, MAX_PROVIDER_RESPONSE)
}

interface ProviderStorePaths {
  encrypted: string
  legacy: string
}

function storePaths(key = accountKey()): ProviderStorePaths {
  const dir = join(app.getPath('userData'), 'db')
  return {
    encrypted: join(dir, `proxy-providers-${key}.enc`),
    legacy: join(dir, `proxy-providers-${key}.json`)
  }
}

async function getProviderCredsAt(paths: ProviderStorePaths): Promise<ProviderCreds> {
  return normalizeCreds(
    (await readSecureJson<ProviderCreds>(paths.encrypted)) ??
    (await migratePlainJson<ProviderCreds>(paths.encrypted, paths.legacy)) ??
    {}
  )
}

export function getProviderCreds(): Promise<ProviderCreds> {
  const paths = storePaths()
  return serializeCredentialAccess(paths, () => getProviderCredsAt(paths))
}

const credentialWriteChains = new Map<string, Promise<unknown>>()

function serializeCredentialAccess<T>(
  paths: ProviderStorePaths,
  fn: () => Promise<T>
): Promise<T> {
  const previous = credentialWriteChains.get(paths.encrypted) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  credentialWriteChains.set(paths.encrypted, settled)
  void settled.finally(() => {
    if (credentialWriteChains.get(paths.encrypted) === settled) {
      credentialWriteChains.delete(paths.encrypted)
    }
  })
  return run
}

export async function saveProviderCreds(patch: ProviderCreds): Promise<ProviderCreds> {
  const paths = storePaths()
  return serializeCredentialAccess(paths, async () => {
    const merged = normalizeCreds({ ...(await getProviderCredsAt(paths)), ...normalizeCreds(patch) })
    await writeSecureJson(paths.encrypted, merged)
    return merged
  })
}

function sessionId(): string {
  return randomBytes(8).toString('base64url')
}

function countryCode(value: unknown): string {
  const country = cleanText(value, 2).trim().toLowerCase()
  return /^[a-z]{2}$/.test(country) ? country : ''
}

function normalizeBuildOptions(value: unknown): ProxyBuildOpts {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<ProxyBuildOpts>)
    : {}
  return {
    country: countryCode(input.country),
    sticky: input.sticky === true,
    sessionMinutes: Math.max(1, Math.min(1440, Math.trunc(Number(input.sessionMinutes) || 10)))
  }
}

function normalizeGenerateOptions(value: unknown): GenerateProxiesOpts {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<GenerateProxiesOpts>)
    : {}
  const lifetime = cleanText(input.lifetime, 16).trim().toLowerCase()
  return {
    count: Math.max(1, Math.min(100, Math.trunc(Number(input.count) || 1))),
    country: countryCode(input.country),
    protocol: input.protocol === 'socks5' ? 'socks5' : 'http',
    sticky: input.sticky === true,
    hard: input.hard === true,
    ...(lifetime ? { lifetime } : {}),
    ...(cleanText(input.label, 160).trim() ? { label: cleanText(input.label, 160).trim() } : {}),
    ...(PROVIDERS.has(input.provider as ProxyProviderId)
      ? { provider: input.provider as ProxyProviderId }
      : {}),
    ...(['rpc', 'rp', 'mp'].includes(cleanText(input.product, 8).trim())
      ? { product: cleanText(input.product, 8).trim() }
      : {})
  }
}

/**
 * Build a usable proxy from the stored provider credentials + options.
 * Gateway/username formats follow each provider's residential docs.
 */
export async function buildProviderProxy(
  provider: ProxyProviderId,
  opts: ProxyBuildOpts
): Promise<ProxyConfig> {
  if (!PROVIDERS.has(provider)) throw new Error('Nhà cung cấp không hợp lệ.')
  opts = normalizeBuildOptions(opts)
  const creds = await getProviderCreds()
  const cc = countryCode(opts.country)
  const sid = sessionId()
  const mins = Math.max(1, Math.min(1440, Math.trunc(Number(opts.sessionMinutes) || 10)))

  if (provider === 'iproyal') {
    const c = creds.iproyal
    if (!c?.username || !c?.password) throw new Error('Chưa nhập tài khoản IPRoyal.')
    let pass = c.password
    if (cc) pass += `_country-${cc}`
    if (opts.sticky) pass += `_session-${sid}_lifetime-${mins}m`
    return { type: 'http', host: 'geo.iproyal.com', port: 12321, username: c.username, password: pass, provider: 'IPRoyal' }
  }

  if (provider === 'oxylabs') {
    const c = creds.oxylabs
    if (!c?.username || !c?.password) throw new Error('Chưa nhập tài khoản Oxylabs.')
    let user = `customer-${c.username}`
    if (cc) user += `-cc-${cc}`
    if (opts.sticky) user += `-sessid-${sid}-sesstime-${mins}`
    return { type: 'http', host: 'pr.oxylabs.io', port: 7777, username: user, password: c.password, provider: 'Oxylabs' }
  }

  if (provider === 'brightdata') {
    const c = creds.brightdata
    if (!c?.customer || !c?.zone || !c?.password) throw new Error('Chưa nhập tài khoản Bright Data.')
    let user = `brd-customer-${c.customer}-zone-${c.zone}`
    if (cc) user += `-country-${cc}`
    if (opts.sticky) user += `-session-${sid}`
    return { type: 'http', host: 'brd.superproxy.io', port: 33335, username: user, password: c.password, provider: 'Bright Data' }
  }

  if (provider === 'evomi') {
    // Evomi bakes country/session/lifetime into the credentials server-side, so ask
    // its generate API for a single proxy and return it — that guarantees the exact
    // username/password format instead of us hand-building it.
    const c = creds.evomi
    if (!c?.apiKey) throw new Error('Chưa nhập API key Evomi.')
    const list = await generateEvomiProxies({
      count: 1,
      country: cc,
      protocol: 'http',
      sticky: !!opts.sticky,
      lifetime: opts.sticky ? `${mins}m` : undefined,
      product: 'rpc'
    })
    const p = list[0]
    if (!p) throw new Error('Evomi không trả về proxy.')
    return sanitizeProxyConfig({ type: p.type, host: p.host, port: p.port, username: p.username, password: p.password, provider: 'Evomi' })
  }

  if (provider === 'cliproxy') {
    // Cliproxy is a gateway provider (no REST API): country/state/session/lifetime are
    // encoded in the username. Sticky ⇒ append `-sid-<id>-t-<minutes>` (max 120 min);
    // each distinct sid = a distinct sticky IP. Rotating ⇒ omit sid.
    const c = creds.cliproxy
    if (!c?.username || !c?.password) throw new Error('Chưa nhập tài khoản Cliproxy.')
    if (!c.port || c.port <= 0) throw new Error('Chưa nhập cổng (port) Cliproxy — xem ở dashboard.')
    const region = (cc || 'us').toUpperCase()
    let user = `${c.username}-region-${region}`
    if (c.state?.trim()) user += `-st-${c.state.trim()}`
    if (opts.sticky) user += `-sid-${sid}-t-${Math.min(120, mins)}`
    return {
      type: 'socks5',
      host: (c.host || 'us.cliproxy.io').trim(),
      port: c.port,
      username: user,
      password: c.password,
      provider: 'Cliproxy'
    }
  }

  throw new Error('Nhà cung cấp không hỗ trợ.')
}

/**
 * Generate N ready-to-use Cliproxy proxies as SavedProxy records (NOT persisted). Cliproxy
 * has NO REST API — the whole "generate" is client-side: build N usernames, each with a
 * fresh session id (`sid`), so each is a DISTINCT sticky IP. Country/state/lifetime are
 * baked into the username. Sticky lifetime is capped at 120 min (Cliproxy's sticky max).
 * Docs: help.cliproxy.com — username `user-region-{CC}-st-{STATE}-sid-{ID}-t-{MINUTES}`.
 */
export async function generateCliproxyProxies(opts: GenerateProxiesOpts): Promise<SavedProxy[]> {
  opts = normalizeGenerateOptions(opts)
  const creds = await getProviderCreds()
  const c = creds.cliproxy
  if (!c?.username || !c?.password) {
    throw new Error('Chưa nhập tài khoản Cliproxy (username/password) — Cài đặt → Nhà cung cấp Proxy.')
  }
  if (!c.port || c.port <= 0) throw new Error('Chưa nhập cổng (port) Cliproxy — xem ở dashboard.')

  const count = Math.max(1, Math.min(100, Math.floor(opts.count || 1)))
  const type: SavedProxy['type'] = opts.protocol === 'socks5' ? 'socks5' : 'http'
  const host = (c.host || 'us.cliproxy.io').trim()
  const region = countryCode(opts.country).toUpperCase() || 'US'
  const state = (c.state ?? '').trim()
  // Cliproxy sticky max is 120 min; default to the max when sticky + no explicit lifetime.
  const mins = Math.min(120, evomiLifetimeMinutes(opts.lifetime) ?? 120)
  const prefix = (opts.label ?? '').trim() || `Cliproxy-${region}`

  const out: SavedProxy[] = []
  for (let i = 0; i < count; i++) {
    let user = `${c.username}-region-${region}`
    if (state) user += `-st-${state}`
    if (opts.sticky) user += `-sid-${sessionId()}-t-${mins}`
    out.push({
      id: genProxyId(),
      label: `${prefix} ${i + 1}`,
      type,
      host,
      port: c.port,
      username: user,
      password: c.password
    })
  }
  return out
}

const genProxyId = (): string => randomUUID()

/**
 * Generate N ready-to-use proxies on demand via the iProyal Residential API and
 * return them as SavedProxy records (NOT persisted — the caller adds them to the
 * pool). Needs the account apiToken (Bearer) + the residential username/password.
 * Docs: POST https://resi-api.iproyal.com/v1/access/generate-proxy-list
 */
export async function generateIproyalProxies(opts: GenerateProxiesOpts): Promise<SavedProxy[]> {
  opts = normalizeGenerateOptions(opts)
  const creds = await getProviderCreds()
  const c = creds.iproyal
  if (!c?.apiToken) throw new Error('Chưa nhập API token iProyal (Dashboard → Settings → API).')
  if (!c?.username || !c?.password) throw new Error('Chưa nhập username/password iProyal.')

  const count = Math.max(1, Math.min(100, Math.floor(opts.count || 1)))
  const cc = countryCode(opts.country)

  // The dashboard "Proxy password" often already has session modifiers appended
  // (e.g. "BASE_country-us_state-colorado_session-xxx_lifetime-59s"). The API wants
  // only the BASE password (it re-adds location/session/lifetime from our params),
  // so strip anything from the first '_' on. iProyal base passwords have no '_'.
  const basePassword = c.password.split('_')[0]

  const body: Record<string, unknown> = {
    format: '{hostname}:{port}:{username}:{password}',
    hostname: 'geo.iproyal.com',
    port: opts.protocol === 'socks5' ? 'socks5' : 'http|https',
    rotation: opts.sticky ? 'sticky' : 'random',
    proxy_count: count,
    username: c.username.trim(),
    password: basePassword
  }
  // Country: only send `location` when a country is chosen. iProyal rejects an empty
  // location ("The location must be a string"); omitting it = any/global.
  if (cc) body.location = `_country-${cc}`
  // Sticky lifetime is already in iProyal's accepted format (s/h). Only send it when
  // provided; an empty value means "default sticky" (iProyal picks the duration).
  const lifetime = (opts.lifetime ?? '').trim()
  if (opts.sticky && lifetime) body.lifetime = lifetime

  const res = await fetch('https://resi-api.iproyal.com/v1/access/generate-proxy-list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error'
  })
  if (!res.ok) {
    const t = await limitedText(res).catch(() => '')
    throw new Error(`iProyal API lỗi HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`)
  }

  const data = await limitedJson<unknown>(res)
  const lines: string[] = Array.isArray(data)
    ? (data as string[])
    : Array.isArray((data as { proxies?: string[] })?.proxies)
      ? (data as { proxies: string[] }).proxies
      : []
  if (!lines.length) throw new Error('iProyal API không trả về proxy nào.')

  const type: SavedProxy['type'] = opts.protocol === 'socks5' ? 'socks5' : 'http'
  const prefix = (opts.label ?? '').trim() || `iProyal${cc ? '-' + cc.toUpperCase() : ''}`
  const out: SavedProxy[] = []
  lines.slice(0, count).forEach((line, i) => {
    // Format "{hostname}:{port}:{username}:{password}" — the password can itself
    // contain ':' so take everything after the 3rd separator as the password.
    const parts = String(line).trim().split(':')
    if (parts.length < 4) return
    const host = parts[0]
    const port = Number(parts[1])
    // Skip a malformed line rather than guessing a port — for SOCKS5 the old HTTP-port
    // fallback (12321) produced a dead proxy pointing at the wrong protocol's port.
    if (
      host.toLowerCase() !== 'geo.iproyal.com' ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535
    ) {
      return
    }
    const username = credential(parts[2], 512)
    const password = credential(parts.slice(3).join(':'), 2048)
    if (!host || !username || !password) return
    out.push({ id: genProxyId(), label: `${prefix} ${i + 1}`, type, host, port, username, password })
  })
  if (!out.length) throw new Error('Không phân tích được proxy iProyal trả về.')
  return out
}

/**
 * Remaining residential traffic (GB) left on the iProyal account, via the API token.
 * iProyal residential proxies are billed by traffic, so this is the "GB còn lại".
 * Docs: GET https://resi-api.iproyal.com/v1/me → { available_traffic: <GB>, subusers_count }.
 */
export async function iproyalBalance(): Promise<{ availableGb: number; subusers: number }> {
  const creds = await getProviderCreds()
  const c = creds.iproyal
  if (!c?.apiToken) {
    throw new Error('Chưa nhập API token iProyal (Cài đặt → Nhà cung cấp Proxy).')
  }
  const res = await fetch('https://resi-api.iproyal.com/v1/me', {
    headers: { Authorization: `Bearer ${c.apiToken}` },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error'
  })
  if (!res.ok) {
    const t = await limitedText(res).catch(() => '')
    throw new Error(`iProyal API lỗi HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`)
  }
  const data = await limitedJson<{ available_traffic?: number; subusers_count?: number }>(res)
  return {
    availableGb: typeof data.available_traffic === 'number' ? data.available_traffic : 0,
    subusers: typeof data.subusers_count === 'number' ? data.subusers_count : 0
  }
}

// ── Evomi ───────────────────────────────────────────────────────────────────
// Evomi's Public API (https://api.evomi.com, header `x-apikey`) is enough on its
// own: GET /public returns each product's username/password/balance, and GET
// /public/generate returns ready-to-use proxy lines with country/session baked in.
// So the app stores ONLY the API key. Docs: https://docs.evomi.com/public-api

const EVOMI_API = 'https://api.evomi.com'

// Connect host + the port for each product's protocol. The generate output already
// carries the right host, but its listed port can be the HTTP port even for a socks5
// request — so we pin the port from this table by product+protocol to be safe.
const EVOMI_HOST: Record<string, string> = {
  rp: 'rp.evomi.com',
  rpc: 'rp.evomi.com',
  mp: 'mp.evomi.com'
}
const EVOMI_PORTS: Record<string, { http: number; socks5: number }> = {
  // Residential ports are doc-confirmed (rp.evomi.com HTTP 1000 / SOCKS5 1002). The
  // generate endpoint returns the HTTP port even for a socks5 request, so we pin the
  // right port here by product+protocol rather than trusting the returned port.
  rp: { http: 1000, socks5: 1002 },
  rpc: { http: 1000, socks5: 1002 },
  mp: { http: 3000, socks5: 3002 }
}

/** Convert an iProyal-style lifetime string ('600s' | '1h' | '30m') to Evomi minutes
 *  (1–1440). Empty/invalid ⇒ undefined (Evomi picks a default). */
function evomiLifetimeMinutes(lt?: string): number | undefined {
  const s = (lt ?? '').trim().toLowerCase()
  if (!s) return undefined
  const m = /^(\d+)\s*(s|m|h)?$/.exec(s)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2] || 's'
  let mins = unit === 'h' ? n * 60 : unit === 'm' ? n : Math.round(n / 60)
  if (!Number.isFinite(mins)) return undefined
  return Math.min(1440, Math.max(1, mins))
}

/** Parse one Evomi generate line into host/user/pass. Handles, in any order:
 *  `host:port:user:pass`, `scheme://host:port:user:pass`, `scheme://user:pass@host:port`,
 *  `user:pass@host:port`. The password can contain ':' (taken as the remainder). */
function parseEvomiLine(
  line: string
): { host: string; port: number; username?: string; password?: string } | null {
  if (line.length > 8192) return null
  let s = line.trim()
  if (!s) return null
  const scheme = s.match(/^(https?|socks5):\/\//i)
  if (scheme) s = s.slice(scheme[0].length)
  if (s.includes('@')) {
    const [cred, hp] = s.split('@')
    const c = cred.split(':')
    const h = hp.split(':')
    const port = Number(h[1])
    if (!h[0] || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    return {
      host: credential(h[0], 253),
      port,
      username: credential(c[0], 512) || undefined,
      password: credential(c.slice(1).join(':'), 2048) || undefined
    }
  }
  const parts = s.split(':')
  if (parts.length >= 4) {
    const port = Number(parts[1])
    if (!parts[0] || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    return {
      host: credential(parts[0], 253),
      port,
      username: credential(parts[2], 512) || undefined,
      password: credential(parts.slice(3).join(':'), 2048) || undefined
    }
  }
  if (parts.length === 2) {
    const port = Number(parts[1])
    if (!parts[0] || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { host: credential(parts[0], 253), port }
  }
  return null
}

/**
 * Generate N ready-to-use proxies via the Evomi Public API and return them as
 * SavedProxy records (NOT persisted — the caller adds them to the pool). Needs only
 * the account apiKey. Docs: GET https://api.evomi.com/public/generate
 */
export async function generateEvomiProxies(opts: GenerateProxiesOpts): Promise<SavedProxy[]> {
  opts = normalizeGenerateOptions(opts)
  const creds = await getProviderCreds()
  const c = creds.evomi
  if (!c?.apiKey) throw new Error('Chưa nhập API key Evomi (Cài đặt → Nhà cung cấp Proxy).')

  const count = Math.max(1, Math.min(100, Math.floor(opts.count || 1)))
  const requestedProduct = cleanText(opts.product, 8).trim()
  const product = ['rpc', 'rp', 'mp'].includes(requestedProduct) ? requestedProduct : 'rpc'
  const proto: 'http' | 'socks5' = opts.protocol === 'socks5' ? 'socks5' : 'http'
  const cc = countryCode(opts.country).toUpperCase()

  const qs = new URLSearchParams()
  qs.set('product', product)
  qs.set('amount', String(count))
  qs.set('protocol', proto)
  qs.set('format', '2') // host:port:user:pass
  qs.set('prepend_protocol', 'false')
  if (cc) qs.set('countries', cc)
  // Hard ⇒ keep the IP as long as it stays connected (the longest Evomi can hold an IP;
  // no lifetime, exceeds the 24h sticky cap). Sticky ⇒ same IP for `lifetime` minutes
  // (max 1440 = 24h). Rotating ⇒ omit `session` so Evomi hands out a new IP each request.
  if (opts.hard) {
    qs.set('session', 'hard')
  } else if (opts.sticky) {
    qs.set('session', 'sticky')
    const mins = evomiLifetimeMinutes(opts.lifetime)
    if (mins) qs.set('lifetime', String(mins))
  }

  // Evomi supports `x-apikey` on Public API endpoints. Keep the secret out of the URL
  // so it cannot leak through proxy/server access logs, history, or error telemetry.
  const res = await fetch(`${EVOMI_API}/public/generate?${qs.toString()}`, {
    headers: { 'x-apikey': c.apiKey.trim() },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error'
  })
  if (!res.ok) {
    const t = await limitedText(res).catch(() => '')
    throw new Error(`Evomi API lỗi HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`)
  }

  const text = await limitedText(res)
  // The generate endpoint returns plain text (one proxy per line); on rejection it may
  // instead return a JSON error body with 200 — surface its message.
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let j: { success?: boolean; message?: string; error?: string } | null = null
    try {
      j = JSON.parse(trimmed)
    } catch {
      j = null
    }
    if (j && j.success === false) throw new Error(j.message || j.error || 'Evomi API từ chối yêu cầu.')
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, count)
  if (!lines.length) throw new Error('Evomi API không trả về proxy nào.')

  const type: SavedProxy['type'] = proto === 'socks5' ? 'socks5' : 'http'
  const fallbackHost = EVOMI_HOST[product] ?? 'rp.evomi.com'
  const pinnedPort = EVOMI_PORTS[product]?.[proto]
  const prefix = (opts.label ?? '').trim() || `Evomi${cc ? '-' + cc : ''}`
  const out: SavedProxy[] = []
  lines.forEach((line, i) => {
    const parsed = parseEvomiLine(line)
    if (!parsed) return
    const host = (parsed.host || fallbackHost).toLowerCase()
    const port = pinnedPort || parsed.port
    if (
      !/^(?:[a-z0-9-]+\.)*evomi\.com$/.test(host) ||
      !port ||
      !parsed.username ||
      !parsed.password
    ) {
      return
    }
    out.push({
      id: genProxyId(),
      label: `${prefix} ${i + 1}`,
      type,
      host,
      port,
      username: parsed.username,
      password: parsed.password
    })
  })
  if (!out.length) throw new Error('Không phân tích được proxy Evomi trả về.')
  return out
}

/**
 * Remaining balance (GB) on the Evomi account for a product, via GET /public.
 * Evomi reports `balance_mb` per product; residential is billed by traffic.
 */
export async function evomiBalance(product?: string): Promise<{ availableGb: number; subusers: number }> {
  const creds = await getProviderCreds()
  const c = creds.evomi
  if (!c?.apiKey) throw new Error('Chưa nhập API key Evomi (Cài đặt → Nhà cung cấp Proxy).')
  const res = await fetch(`${EVOMI_API}/public`, {
    headers: { 'x-apikey': c.apiKey.trim() },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error'
  })
  if (!res.ok) {
    const t = await limitedText(res).catch(() => '')
    throw new Error(`Evomi API lỗi HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`)
  }
  const data = await limitedJson<{ products?: Record<string, { balance_mb?: number }> }>(res)
  const products = data.products || {}
  const requested = cleanText(product, 8).trim()
  const key = ['rpc', 'rp', 'mp'].includes(requested) ? requested : 'rpc'
  const mb =
    typeof products[key]?.balance_mb === 'number'
      ? (products[key]!.balance_mb as number)
      : Object.values(products).reduce(
          (sum, p) => sum + (typeof p.balance_mb === 'number' ? p.balance_mb : 0),
          0
        )
  // Evomi reports GB in DECIMAL (SI) units to match its dashboard: GB = MB / 1000
  // (their bandwidth API proves it: 43971237.38 MB = 43971.24 GB). NOT MB / 1024.
  return { availableGb: mb / 1000, subusers: 0 }
}
