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
import type { ProxyConfig, ProxyProviderId, ProviderCreds, ProxyBuildOpts } from '../shared/types'

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
