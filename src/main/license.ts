// ── VGC Browser — internal-access gate (admin approval list) ─────────────────
// VGC Browser is an INTERNAL tool: only emails the administrator added on
// vgcbrowser.com/quanly may use it. The app asks check.php whether the signed-in
// email is on that list and caches a positive answer for 24 h so a network blip never
// locks out an approved colleague. It is consulted at sign-in (Gate.tsx), every few
// minutes while the app is open, and again on every profile launch (profile-manager).
//
// Every call resolves with the verdict computed FOR THAT CALL. The module-global
// `state` is only a convenience cache and is committed solely by the task for the most
// recently requested email, so a slow reply for a previous account can never overwrite
// the verdict of the account that is signed in now.

import { app } from 'electron'
import { join } from 'path'
import { getMachineId, getMachineName } from './machine-id'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'
import { readLimitedResponseJson } from './http-limit'
import type { LicenseStatus } from '../shared/types'

const API = 'https://vgcbrowser.com/quanly/check.php'
const REGISTER_API = 'https://vgcbrowser.com/quanly/register.php'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 64 * 1024
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** While inside the app, this many consecutive "server unreachable and no approval in the
 *  last 24 h" verdicts end the session — one alone may be a cache-write hiccup. */
const UNVERIFIED_STREAK_TO_REVOKE = 2

interface CachedDecision {
  approved: boolean
  checkedAt: number
}

interface CheckResponse {
  approved?: boolean
  reason?: string
  expires?: string | null
}

const SIGNED_OUT: LicenseStatus = { email: '', approved: false, reason: 'not-signed-in', expires: null }

let state: LicenseStatus = { ...SIGNED_OUT, reason: 'init' }
/** Email of the most recent refresh request — the only task allowed to commit `state`. */
let currentEmail = ''
/** One server round-trip per email at a time: sign-in triggers the check from both the
 *  session commit and the renderer gate within the same second. */
const inFlight = new Map<string, Promise<LicenseStatus>>()
/** In-memory twin of the on-disk approval cache: keeps 'recent-cache' working within one
 *  app session even when the userData dir refuses the encrypted write. */
const lastApprovedAt = new Map<string, number>()
/** Consecutive 'unverified' verdicts for `currentEmail` (reset by any other verdict). */
let unverifiedStreak = 0

function cacheFile(): string {
  return join(app.getPath('userData'), 'vgc-license.enc')
}

function legacyCacheFile(): string {
  return join(app.getPath('userData'), 'vgc-license.json')
}

function normalizeEmail(email: unknown): string {
  return (typeof email === 'string' ? email : '').toLowerCase().trim().slice(0, 320)
}

async function loadCache(): Promise<Record<string, CachedDecision>> {
  try {
    const raw =
      (await readSecureJson<Record<string, CachedDecision | boolean>>(cacheFile())) ??
      (await migratePlainJson<Record<string, CachedDecision | boolean>>(cacheFile(), legacyCacheFile())) ??
      {}
    const now = Date.now()
    const out: Record<string, CachedDecision> = {}
    for (const [email, value] of Object.entries(raw)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof value.approved === 'boolean' &&
        Number.isFinite(value.checkedAt) &&
        value.checkedAt <= now
      ) {
        out[email] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

async function saveDecision(email: string, approved: boolean): Promise<void> {
  const fresh = await loadCache()
  fresh[email] = { approved, checkedAt: Date.now() }
  await writeSecureJson(cacheFile(), fresh)
}

async function smallJson<T>(response: Response): Promise<T> {
  return readLimitedResponseJson<T>(response, MAX_RESPONSE_BYTES)
}

/** check.php answers `approved:false` with these reasons when IT is broken (sqlite file
 *  missing / PDO exception), not when the email is unknown. Treat them like an unreachable
 *  server so a hosting hiccup neither blocks nor un-caches an approved colleague. */
const SERVER_FAULT_REASONS = new Set(['err', 'no-db'])

/** Ask the admin list about one email. Throws on any transport/HTTP/server-side problem so
 *  callers can tell "the server said no" apart from "could not ask the server". */
async function queryServer(email: string): Promise<CheckResponse> {
  const r = await fetch(`${API}?email=${encodeURIComponent(email)}`, {
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
    redirect: 'error'
  })
  if (!r.ok) {
    await r.body?.cancel().catch(() => {})
    throw new Error(`License HTTP ${r.status}`)
  }
  const j = await smallJson<CheckResponse>(r)
  if (!j || typeof j !== 'object') throw new Error('License: malformed response')
  if (j.approved !== true && SERVER_FAULT_REASONS.has(String(j.reason))) {
    throw new Error(`License server fault: ${j.reason}`)
  }
  return j
}

function reasonOf(j: CheckResponse, approved: boolean): string {
  if (typeof j.reason === 'string' && j.reason) return j.reason.slice(0, 120)
  return approved ? 'ok' : 'not-approved'
}

function expiresOf(j: CheckResponse): string | null {
  return typeof j.expires === 'string' && j.expires ? j.expires.slice(0, 40) : null
}

async function approvedRecently(email: string): Promise<boolean> {
  const now = Date.now()
  const mem = lastApprovedAt.get(email)
  if (mem !== undefined && now - mem <= CACHE_TTL_MS) return true
  const cached = (await loadCache())[email]
  return Boolean(cached?.approved && now - cached.checkedAt <= CACHE_TTL_MS)
}

/** Compute the verdict for one email: server answer, else the 24 h cache. */
async function verdictFor(e: string): Promise<LicenseStatus> {
  try {
    const j = await queryServer(e)
    const approved = j.approved === true
    if (approved) lastApprovedAt.set(e, Date.now())
    else lastApprovedAt.delete(e)
    await saveDecision(e, approved).catch(() => {})
    return { email: e, approved, reason: reasonOf(j, approved), expires: expiresOf(j) }
  } catch {
    const fresh = await approvedRecently(e)
    return { email: e, approved: fresh, reason: fresh ? 'recent-cache' : 'unverified', expires: null }
  }
}

/** Commit a verdict as the module state, but only if it is about the email that was
 *  requested most recently (a late reply for a previous account is dropped). */
function commit(e: string, verdict: LicenseStatus): void {
  if (e !== currentEmail) return
  state = verdict
  unverifiedStreak = verdict.reason === 'unverified' ? unverifiedStreak + 1 : 0
}

/** Re-check an email against the admin list. Resolves with the verdict for THIS call:
 *  approved right now, or approved within the last 24 h while the server cannot be reached
 *  ('recent-cache'). Pass the signed-in email (main derives it from the validated JWT). */
export function refreshLicense(email: string | null): Promise<LicenseStatus> {
  const e = normalizeEmail(email)
  if (e !== currentEmail) {
    currentEmail = e
    unverifiedStreak = 0
    state = e ? { ...SIGNED_OUT, email: e, reason: 'checking' } : { ...SIGNED_OUT }
  }
  if (!EMAIL_RE.test(e)) return Promise.resolve({ ...SIGNED_OUT })
  const running = inFlight.get(e)
  if (running) return running
  const task = verdictFor(e).then(
    (verdict) => {
      inFlight.delete(e)
      commit(e, verdict)
      return verdict
    },
    () => {
      // verdictFor never rejects, but keep the map consistent no matter what.
      inFlight.delete(e)
      return { email: e, approved: false, reason: 'unverified', expires: null }
    }
  )
  inFlight.set(e, task)
  return task
}

/** Sign-up pre-check: may this email create an account at all? Only emails the admin
 *  already put on the internal list may register. Never cached and never touches
 *  `state` — the caller is not signed in yet. */
export async function precheckEmail(email: unknown): Promise<{ approved: boolean; reason: string }> {
  const e = normalizeEmail(email)
  if (!EMAIL_RE.test(e)) return { approved: false, reason: 'invalid-email' }
  try {
    const j = await queryServer(e)
    const approved = j.approved === true
    return { approved, reason: reasonOf(j, approved) }
  } catch {
    return { approved: false, reason: 'unverified' }
  }
}

/** True when the server itself said "no" (not on the list / expired), as opposed to
 *  "could not reach the server". */
export function isPositivelyDenied(s: LicenseStatus): boolean {
  return !s.approved && (s.reason === 'not-approved' || s.reason === 'expired')
}

/** Must a user who is already INSIDE the app be thrown out on this verdict? Yes on a
 *  positive denial, and yes when the server has been unreachable with no approval in the
 *  last 24 h for two checks in a row (someone blocking vgcbrowser.com must not keep a
 *  revoked account alive forever). A single 'unverified' or a 'recent-cache' keeps them in. */
export function shouldRevoke(s: LicenseStatus): boolean {
  if (s.approved) return false
  if (isPositivelyDenied(s)) return true
  return s.reason === 'unverified' && s.email === currentEmail && unverifiedStreak >= UNVERIFIED_STREAK_TO_REVOKE
}

export async function reportRegistration(email: string | null): Promise<void> {
  const e = normalizeEmail(email)
  if (!EMAIL_RE.test(e)) return
  try {
    const response = await fetch(REGISTER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: e,
        machineId: getMachineId(),
        machineName: getMachineName().slice(0, 255),
        os: process.platform
      }),
      signal: AbortSignal.timeout(8000),
      redirect: 'error'
    })
    await response.body?.cancel().catch(() => {})
  } catch {
    // Registration telemetry must not affect login.
  }
}

/** Last committed verdict for the current email (a cache — prefer the value returned by
 *  refreshLicense when you just called it). */
export function isLicensed(): boolean {
  return state.approved
}

export function licenseState(): LicenseStatus {
  return { ...state }
}
