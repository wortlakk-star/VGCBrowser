// ── VGC Browser — cross-machine EXCLUSIVE profile lock ───────────────────────
// Only one machine may have a given profile open at a time (GoLogin/Multilogin style).
// Opening a profile CLAIMS the lock, which bumps a monotonic `epoch`; the machine currently
// holding it detects the higher epoch on its next poll and closes (after saving its session).
// A machine "holds" the lock iff the row's epoch equals the epoch it was given at claim time —
// so a cloned install (duplicate machine id) or a same-machine reopen can never be confused
// for the current holder. All calls are raw REST/RPC to Supabase (matching cloud-data.ts) and
// FAIL OPEN: any cloud/RPC error or not-signed-in NEVER blocks opening a profile and NEVER
// triggers a false kick. Requires supabase/profile-locks.sql to be applied.

import { getSettings } from './settings'
import { getCloudSession } from './session'
import { getMachineId, getMachineName } from './machine-id'
import { requireProfileId } from './validation'

const RPC_TIMEOUT_MS = 12_000

export interface ClaimResult {
  /** The epoch this open now holds (its identity for poll/release/tag). */
  epoch: number
  /** A machine held this profile immediately before we claimed it (may be THIS machine on a
   *  reopen; compare against getMachineId() if you need to know). Null if the lock was free. */
  previousHolder: string | null
  /** The previous holder had a fresh heartbeat (< 30s) → a live open we should wait to hand off. */
  previousFresh: boolean
}

/** Result of a hold-poll: `ok:false` = transient error / not signed in → caller must NOT kick.
 *  `epoch:null` = the lock row is gone → also do not kick. Otherwise `epoch` is the CURRENT
 *  epoch; the caller compares it to the epoch it holds. */
export interface PollResult {
  ok: boolean
  epoch: number | null
}

async function creds(): Promise<{ url: string; anon: string; token: string; uid: string } | null> {
  const session = getCloudSession()
  if (!session) return null // not signed into cloud → locking disabled (local-only)
  try {
    const s = await getSettings()
    if (!s.supabaseUrl || !s.supabaseAnonKey) return null
    return { url: s.supabaseUrl, anon: s.supabaseAnonKey, token: session.accessToken, uid: session.uid }
  } catch {
    return null // fail-open
  }
}

/** Returns { ok, value }: ok=false marks a transient failure (network / non-2xx / not signed in)
 *  so callers can distinguish "the RPC failed" from "the RPC legitimately returned null". */
async function rpc(fn: string, body: Record<string, unknown>): Promise<{ ok: boolean; value: unknown }> {
  const c = await creds()
  if (!c) return { ok: false, value: null }
  try {
    const res = await fetch(`${c.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: c.anon,
        Authorization: `Bearer ${c.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    })
    if (!res.ok) return { ok: false, value: null }
    const text = await res.text()
    return { ok: true, value: text ? JSON.parse(text) : null }
  } catch {
    return { ok: false, value: null } // fail-open
  }
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Become the holder of this profile's lock (bumps the epoch). Returns the epoch we now hold
 *  plus info about the previous holder, or null when locking is unavailable (not signed in /
 *  cloud error / migration not applied) — the caller then opens WITHOUT cross-machine protection. */
export async function claimProfileLock(id: string): Promise<ClaimResult | null> {
  const pid = requireProfileId(id)
  const { ok, value } = await rpc('claim_profile_lock', {
    p_profile_id: pid,
    p_device: getMachineId(),
    p_name: getMachineName()
  })
  if (!ok || value == null) return null
  const row = Array.isArray(value) ? value[0] : value
  const rec = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  const epoch = toNum(rec.my_epoch)
  if (epoch == null) return null // malformed → treat as unavailable (fail-open)
  const previousHolder =
    typeof rec.previous_holder === 'string' && rec.previous_holder ? rec.previous_holder : null
  return { epoch, previousHolder, previousFresh: rec.previous_fresh === true }
}

/** Poll the lock while holding epoch `epoch`. Heartbeats us (server-side, only while we still
 *  hold) and returns the CURRENT epoch so the caller can detect a takeover (current > ours). */
export async function pollProfileLock(id: string, epoch: number): Promise<PollResult> {
  const pid = requireProfileId(id)
  const { ok, value } = await rpc('poll_profile_lock', { p_profile_id: pid, p_epoch: epoch })
  if (!ok) return { ok: false, epoch: null }
  return { ok: true, epoch: toNum(value) } // value may be null (row gone) → epoch:null
}

/** Free the lock on a clean close — server-side no-op unless this exact epoch still holds it,
 *  so a delayed release can never delete a newer generation another open just claimed. */
export async function releaseProfileLock(id: string, epoch: number): Promise<void> {
  await rpc('release_profile_lock', { p_profile_id: requireProfileId(id), p_epoch: epoch })
}

/** After the kicked machine uploads its final session, record its ETag for the TAKEOVER epoch
 *  it observed, so the taking-over open knows the fresh session is ready — and a straggler from
 *  an older cycle cannot satisfy a newer claimer's wait (server gates on the epoch). */
export async function publishSessionTag(id: string, takeoverEpoch: number, tag: string): Promise<void> {
  if (!tag) return
  await rpc('set_lock_session_tag', {
    p_profile_id: requireProfileId(id),
    p_epoch: takeoverEpoch,
    p_tag: tag
  })
}

async function readSessionTag(id: string): Promise<string | null> {
  const c = await creds()
  if (!c) return null
  try {
    const url =
      `${c.url}/rest/v1/profile_locks?owner=eq.${encodeURIComponent(c.uid)}` +
      `&profile_id=eq.${encodeURIComponent(requireProfileId(id))}&select=session_tag`
    const res = await fetch(url, {
      headers: { apikey: c.anon, Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{ session_tag: string | null }>
    return rows?.[0]?.session_tag ?? null
  } catch {
    return null
  }
}

/** The claimer waits here for the previous holder to save + publish its fresh session tag onto
 *  OUR row (claim reset session_tag to null, so ANY non-null value means the previous holder
 *  finished uploading for our epoch). Returns true if the hand-off completed, false on timeout —
 *  the caller then downloads whatever is already in the cloud (the previous holder is offline /
 *  slow); the close-side anti-clobber guard (cloud-data.ts) still protects a newer session from
 *  being overwritten if this open turns out to have loaded a stale one. */
export async function waitForHandoff(id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tag = await readSessionTag(id)
    if (tag) return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}
