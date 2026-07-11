// ── VGC Browser — proxy provider connectors ─────────────────────────────────
// Store account credentials for IPRoyal / Oxylabs / Bright Data (per cloud
// account) and build a ready-to-use proxy connection (gateway host:port +
// username encoding country/session) — like GoLogin's "connect proxy provider".
// The provider "API" for residential pools is the gateway: routing is done by
// formatting the username/password; no per-request API call is needed to use it.

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { accountKey } from './session'
import type {
  ProxyConfig,
  ProxyProviderId,
  ProviderCreds,
  ProxyBuildOpts,
  GenerateProxiesOpts,
  SavedProxy
} from '../shared/types'

function file(): string {
  return join(app.getPath('userData'), 'db', `proxy-providers-${accountKey()}.json`)
}

export async function getProviderCreds(): Promise<ProviderCreds> {
  try {
    return JSON.parse(await fs.readFile(file(), 'utf-8')) as ProviderCreds
  } catch {
    return {}
  }
}

export async function saveProviderCreds(patch: ProviderCreds): Promise<ProviderCreds> {
  await fs.mkdir(join(app.getPath('userData'), 'db'), { recursive: true })
  const merged = { ...(await getProviderCreds()), ...patch }
  await fs.writeFile(file(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

function sessionId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Build a usable proxy from the stored provider credentials + options.
 * Gateway/username formats follow each provider's residential docs.
 */
export async function buildProviderProxy(
  provider: ProxyProviderId,
  opts: ProxyBuildOpts
): Promise<ProxyConfig> {
  const creds = await getProviderCreds()
  const cc = (opts.country ?? '').trim().toLowerCase()
  const sid = sessionId()
  const mins = opts.sessionMinutes && opts.sessionMinutes > 0 ? opts.sessionMinutes : 10

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

  throw new Error('Nhà cung cấp không hỗ trợ.')
}

const genProxyId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

/**
 * Generate N ready-to-use proxies on demand via the iProyal Residential API and
 * return them as SavedProxy records (NOT persisted — the caller adds them to the
 * pool). Needs the account apiToken (Bearer) + the residential username/password.
 * Docs: POST https://resi-api.iproyal.com/v1/access/generate-proxy-list
 */
export async function generateIproyalProxies(opts: GenerateProxiesOpts): Promise<SavedProxy[]> {
  const creds = await getProviderCreds()
  const c = creds.iproyal
  if (!c?.apiToken) throw new Error('Chưa nhập API token iProyal (Dashboard → Settings → API).')
  if (!c?.username || !c?.password) throw new Error('Chưa nhập username/password iProyal.')

  const count = Math.max(1, Math.min(100, Math.floor(opts.count || 1)))
  const cc = (opts.country ?? '').trim().toLowerCase()

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
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`iProyal API lỗi HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`)
  }

  const data = (await res.json()) as unknown
  const lines: string[] = Array.isArray(data)
    ? (data as string[])
    : Array.isArray((data as { proxies?: string[] })?.proxies)
      ? (data as { proxies: string[] }).proxies
      : []
  if (!lines.length) throw new Error('iProyal API không trả về proxy nào.')

  const type: SavedProxy['type'] = opts.protocol === 'socks5' ? 'socks5' : 'http'
  const prefix = (opts.label ?? '').trim() || `iProyal${cc ? '-' + cc.toUpperCase() : ''}`
  const out: SavedProxy[] = []
  lines.forEach((line, i) => {
    // Format "{hostname}:{port}:{username}:{password}" — the password can itself
    // contain ':' so take everything after the 3rd separator as the password.
    const parts = String(line).trim().split(':')
    if (parts.length < 4) return
    const host = parts[0]
    let port = Number(parts[1])
    if (!Number.isInteger(port) || port <= 0) port = 12321 // iProyal residential default
    const username = parts[2]
    const password = parts.slice(3).join(':')
    if (!host || !username || !password) return
    out.push({ id: genProxyId(), label: `${prefix} ${i + 1}`, type, host, port, username, password })
  })
  if (!out.length) throw new Error('Không phân tích được proxy iProyal trả về.')
  return out
}
