// ── VGC Browser — access licensing (admin-approved email allowlist) ──────────
// Only emails the admin approved (managed at https://vgcbrowser.com/quanly) may use
// VGC Browser. On cloud login (and again right before a profile opens) we ask the
// allowlist API whether the signed-in email is approved; launching a profile is blocked
// otherwise. Fail-safe: a transient network error falls back to the last-known cached
// result per email, so a server blip never locks out an already-approved user — but an
// email that has never been approved (no cache) stays blocked.

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { getMachineId, getMachineName } from './machine-id'

const API = 'https://vgcbrowser.com/quanly/check.php'
const REGISTER_API = 'https://vgcbrowser.com/quanly/register.php'

// Owner emails that are ALWAYS licensed — a hard safety net so the admin can never be
// locked out of their own app, even if the allowlist server is unreachable.
const ALWAYS_ALLOWED = new Set(['c.d.wortl@gmail.com'])

let state: { email: string; approved: boolean; reason: string } = { email: '', approved: false, reason: 'init' }

function cacheFile(): string {
  return join(app.getPath('userData'), 'vgc-license.json')
}
function loadCache(): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(cacheFile(), 'utf-8')) as Record<string, boolean>
  } catch {
    return {}
  }
}
function saveCache(c: Record<string, boolean>): void {
  try {
    writeFileSync(cacheFile(), JSON.stringify(c))
  } catch {
    /* best-effort */
  }
}

/** Ask the allowlist whether `email` may use VGC. Updates cached state; returns approved. */
export async function refreshLicense(email: string | null): Promise<boolean> {
  const e = (email || '').toLowerCase().trim()
  if (!e) {
    state = { email: '', approved: false, reason: 'not-signed-in' }
    return false
  }
  if (ALWAYS_ALLOWED.has(e)) {
    state = { email: e, approved: true, reason: 'owner' }
    return true
  }
  const cache = loadCache()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch(`${API}?email=${encodeURIComponent(e)}`, { signal: ctrl.signal }).finally(() =>
      clearTimeout(timer)
    )
    const j = (await r.json()) as { approved?: boolean; reason?: string }
    const approved = j.approved === true
    state = { email: e, approved, reason: j.reason ?? (approved ? 'ok' : 'not-approved') }
    cache[e] = approved
    saveCache(cache)
    return approved
  } catch {
    // Network error → trust the last-known cached decision (don't lock out on a blip).
    const cached = cache[e] === true
    state = { email: e, approved: cached, reason: cached ? 'cache' : 'unverified' }
    return cached
  }
}

/**
 * Fire-and-forget: tell the admin panel (/quanly) this email just signed in — from which
 * machine (a stable per-machine id + hostname) and, resolved server-side from the request
 * IP, which country. Lets the admin SEE new sign-ups (with country + machine) and approve
 * them there. Never blocks or throws: registration reporting must not affect login.
 */
export async function reportRegistration(email: string | null): Promise<void> {
  const e = (email || '').toLowerCase().trim()
  if (!e) return
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    await fetch(REGISTER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: e,
        machineId: getMachineId(),
        machineName: getMachineName(),
        os: process.platform
      }),
      signal: ctrl.signal
    }).finally(() => clearTimeout(timer))
  } catch {
    /* best-effort */
  }
}

export function isLicensed(): boolean {
  return state.approved
}

export function licenseState(): { email: string; approved: boolean; reason: string } {
  return state
}
