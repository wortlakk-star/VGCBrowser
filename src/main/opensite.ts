// ── VGC Browser — OpenSite dashboard client ──────────────────────────────────
// A thin REST client for the OpenSite platform (api-v2.opensitex.store), driven
// from the main process so it is free of browser CORS. The user signs in with
// their own admin/master credentials; we keep the Bearer token in memory (and,
// if they opt in, the password on disk for silent re-login when the token
// expires). The renderer only ever sees unwrapped JSON payloads.
//
// Auth contract (reverse-engineered from the OpenSite web app):
//   POST /auth/login            { email, password }        → { data: { token, user } }
//                                                          or { data: { twoFactorRequired: true } }
//   POST /auth/2fa/verify-totp  { code }  (+ login cookie) → { data: { token, user } }
//   GET  <any>                  Authorization: Bearer <token>
// Every response is wrapped as { statusCode, success, data | errors, … }.

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  OpenSiteFetchResult,
  OpenSiteLoginResult,
  OpenSiteStatus,
  OpenSiteUser
} from '../shared/types'

const DEFAULT_BASE = 'https://api-v2.opensitex.store/api'

interface Persisted {
  baseUrl?: string
  email?: string
  token?: string
  user?: OpenSiteUser
  /** Only present when the user ticked "remember me". */
  password?: string
}

interface State extends Persisted {
  /** Cookies captured from auth responses (temp 2FA session, refresh cookie…). */
  cookies: Record<string, string>
  /** Password held only for the current login→2FA handshake. */
  pendingPassword?: string
}

let state: State = { cookies: {} }
let loaded = false

function stateFile(): string {
  return join(app.getPath('userData'), 'opensite.json')
}

function baseUrl(): string {
  return (state.baseUrl && state.baseUrl.trim()) || DEFAULT_BASE
}

async function load(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = await fs.readFile(stateFile(), 'utf-8')
    const p = JSON.parse(raw) as Persisted
    state = { ...state, ...p, cookies: {} }
  } catch {
    /* first run — no file yet */
  }
}

async function persist(): Promise<void> {
  const out: Persisted = {
    baseUrl: state.baseUrl,
    email: state.email,
    token: state.token,
    user: state.user,
    ...(state.password ? { password: state.password } : {})
  }
  try {
    await fs.writeFile(stateFile(), JSON.stringify(out, null, 2), 'utf-8')
  } catch {
    /* non-fatal: session just won't survive a restart */
  }
}

function cookieHeader(): string {
  return Object.entries(state.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

function captureCookies(res: Response): void {
  // undici (Node 20) exposes getSetCookie(); fall back to the single header.
  const getSet = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  const raw = typeof getSet === 'function' ? getSet.call(res.headers) : []
  const list = raw.length ? raw : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : [])
  for (const line of list) {
    const first = line.split(';')[0]
    const eq = first.indexOf('=')
    if (eq > 0) state.cookies[first.slice(0, eq).trim()] = first.slice(eq + 1).trim()
  }
}

/** Unwrap the { data } envelope; return the inner payload (or the body itself). */
function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>).data
  }
  return body
}

function errorOf(body: unknown, res: Response): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const e = b.errors ?? b.error ?? b.message
    if (typeof e === 'string' && e) return e
    if (Array.isArray(e) && e.length) return e.map(String).join(', ')
  }
  return `HTTP ${res.status}`
}

interface RawResult {
  res: Response
  body: unknown
}

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean } = {}
): Promise<RawResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false && state.token) headers.Authorization = `Bearer ${state.token}`
  const cookie = cookieHeader()
  if (cookie) headers.Cookie = cookie
  const res = await fetch(baseUrl() + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  })
  captureCookies(res)
  let body: unknown = null
  const text = await res.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { res, body }
}

/** Apply the { token, user } payload from a successful login / 2FA step. */
async function applyAuth(payload: unknown): Promise<boolean> {
  const p = (payload ?? {}) as Record<string, unknown>
  const token = (p.token ?? p.accessToken ?? p.access_token) as string | undefined
  if (!token || typeof token !== 'string') return false
  state.token = token
  state.user = (p.user as OpenSiteUser | undefined) ?? state.user
  if (state.user?.email) state.email = state.user.email
  // Promote a remembered password out of the transient handshake slot.
  if (state.pendingPassword) {
    state.password = state.pendingPassword
    state.pendingPassword = undefined
  }
  await persist()
  return true
}

function toStatus(): OpenSiteStatus {
  return {
    loggedIn: !!state.token,
    email: state.email ?? state.user?.email,
    role: state.user?.role,
    user: state.user,
    baseUrl: baseUrl(),
    remembered: !!state.password
  }
}

export async function opensiteStatus(): Promise<OpenSiteStatus> {
  await load()
  return toStatus()
}

export async function opensiteSetBaseUrl(url: string): Promise<OpenSiteStatus> {
  await load()
  state.baseUrl = url.trim() || undefined
  await persist()
  return toStatus()
}

export async function opensiteLogin(
  email: string,
  password: string,
  remember: boolean
): Promise<OpenSiteLoginResult> {
  await load()
  state.cookies = {}
  try {
    const { res, body } = await request('POST', '/auth/login', {
      auth: false,
      body: { email, password }
    })
    const payload = unwrap(body) as Record<string, unknown> | undefined
    const twoFA =
      !!payload?.twoFactorRequired ||
      !!(body as Record<string, unknown>)?.twoFactorRequired
    if (twoFA) {
      // Hold the credentials so verifyTotp can finish, and (optionally) remember.
      state.email = email
      state.pendingPassword = password
      if (remember) state.password = password
      return { ok: false, twoFactorRequired: true, status: toStatus() }
    }
    if (res.ok && (await applyAuth(payload))) {
      state.email = email
      if (remember) state.password = password
      else state.password = undefined
      await persist()
      return { ok: true, status: toStatus() }
    }
    return { ok: false, error: errorOf(body, res) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function opensiteVerifyTotp(code: string): Promise<OpenSiteLoginResult> {
  await load()
  try {
    const { res, body } = await request('POST', '/auth/2fa/verify-totp', {
      auth: false,
      body: { code: code.trim() }
    })
    const payload = unwrap(body)
    if (res.ok && (await applyAuth(payload))) {
      await persist()
      return { ok: true, status: toStatus() }
    }
    return { ok: false, twoFactorRequired: true, error: errorOf(body, res) }
  } catch (e) {
    return { ok: false, twoFactorRequired: true, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Re-login silently using a remembered password (after a token expiry). */
async function silentRelogin(): Promise<boolean> {
  if (!state.email || !state.password) return false
  const { res, body } = await request('POST', '/auth/login', {
    auth: false,
    body: { email: state.email, password: state.password }
  })
  if (!res.ok) return false
  return applyAuth(unwrap(body))
}

/** GET a single path with the Bearer token, retrying once after a silent re-login on 401. */
async function getPath(path: string): Promise<OpenSiteFetchResult> {
  let { res, body } = await request('GET', path)
  if (res.status === 401 && (await silentRelogin())) {
    ;({ res, body } = await request('GET', path))
  }
  if (res.ok) return { ok: true, status: res.status, data: unwrap(body), path }
  return { ok: false, status: res.status, error: errorOf(body, res), path }
}

/**
 * GET the first candidate path that succeeds. Used for role fallback: an admin
 * token answers /admin/*, a master token /master/*, a seller token /seller/*.
 * A 401 aborts early (auth problem, not a wrong-role problem).
 */
export async function opensiteFetch(paths: string[]): Promise<OpenSiteFetchResult> {
  await load()
  if (!state.token && !(await silentRelogin())) {
    return { ok: false, status: 401, error: 'Chưa đăng nhập OpenSite.' }
  }
  let last: OpenSiteFetchResult = { ok: false, error: 'Không có endpoint nào phù hợp.' }
  for (const p of paths) {
    const r = await getPath(p)
    if (r.ok) return r
    last = r
    if (r.status === 401) break
  }
  return last
}

export async function opensiteLogout(): Promise<OpenSiteStatus> {
  await load()
  try {
    if (state.token) await request('POST', '/auth/logout', { body: {} })
  } catch {
    /* best-effort */
  }
  state = { cookies: {}, baseUrl: state.baseUrl }
  await persist()
  return toStatus()
}
