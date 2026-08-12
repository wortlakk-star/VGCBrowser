import { app } from 'electron'
import { join } from 'path'
import { getMachineId, getMachineName } from './machine-id'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'
import { readLimitedResponseJson } from './http-limit'

const API = 'https://vgcbrowser.com/quanly/check.php'
const REGISTER_API = 'https://vgcbrowser.com/quanly/register.php'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 64 * 1024

interface CachedDecision {
  approved: boolean
  checkedAt: number
}

let state: { email: string; approved: boolean; reason: string } = {
  email: '',
  approved: false,
  reason: 'init'
}

function cacheFile(): string {
  return join(app.getPath('userData'), 'vgc-license.enc')
}

function legacyCacheFile(): string {
  return join(app.getPath('userData'), 'vgc-license.json')
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

export async function refreshLicense(email: string | null): Promise<boolean> {
  const e = (email || '').toLowerCase().trim().slice(0, 320)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    state = { email: '', approved: false, reason: 'not-signed-in' }
    return false
  }
  try {
    const r = await fetch(`${API}?email=${encodeURIComponent(e)}`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      redirect: 'error'
    })
    if (!r.ok) {
      await r.body?.cancel().catch(() => {})
      throw new Error(`License HTTP ${r.status}`)
    }
    const j = await smallJson<{ approved?: boolean; reason?: string }>(r)
    const approved = j.approved === true
    state = {
      email: e,
      approved,
      reason: typeof j.reason === 'string' ? j.reason.slice(0, 120) : approved ? 'ok' : 'not-approved'
    }
    await saveDecision(e, approved).catch(() => {})
    return approved
  } catch {
    const cached = (await loadCache())[e]
    const fresh = Boolean(cached?.approved && Date.now() - cached.checkedAt <= CACHE_TTL_MS)
    state = { email: e, approved: fresh, reason: fresh ? 'recent-cache' : 'unverified' }
    return fresh
  }
}

export async function reportRegistration(email: string | null): Promise<void> {
  const e = (email || '').toLowerCase().trim().slice(0, 320)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return
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

export function isLicensed(): boolean {
  return state.approved
}

export function licenseState(): { email: string; approved: boolean; reason: string } {
  return state
}
