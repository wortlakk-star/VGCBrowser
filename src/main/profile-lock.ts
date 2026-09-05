// ── VGC Browser — cross-machine EXCLUSIVE profile lock ───────────────────────
// Only one machine may have a given profile open at a time (GoLogin/Multilogin style).
// Opening a profile CLAIMS the lock, which bumps a monotonic `epoch`; the machine currently
// holding it detects the higher epoch on its next poll and closes (after saving its session).
// A machine "holds" the lock iff the row's epoch equals the epoch it was given at claim time —
// so a cloned install (duplicate machine id) or a same-machine reopen can never be confused
// for the current holder. All calls are raw REST/RPC to Supabase (matching cloud-data.ts) and
// FAIL OPEN: any cloud/RPC error or not-signed-in NEVER blocks opening a profile and NEVER
// triggers a false kick — but every failure is logged (vgc-sess.log) with its reason, and the
// caller surfaces "opened without cross-machine protection" to the user.
// Requires supabase/profile-locks.sql to be applied.
//
// HAND-OFF PROTOCOL over the single `session_tag` column (no schema change needed):
//   • claim resets session_tag to NULL for the new epoch.
//   • The kicked holder, while it saves, refreshes `saving:<n>` (n increments every few seconds)
//     via set_lock_session_tag — accepted only while the kicker's epoch is still current. The
//     claimer keeps waiting as long as that counter keeps moving (clock-independent), up to a
//     hard cap, instead of a blind fixed budget.
//   • When the save is done the kicked holder publishes the real cloud ETag; on failure it
//     publishes `failed:<reason>` so the claimer stops waiting immediately and is told why.
//   • A NORMAL close (not kicked) that finishes uploading after another machine has already
//     claimed publishes the ETag for the CURRENT epoch too (profile-manager.ts), so a claimer
//     that arrived mid-upload is not stuck waiting for a tag nobody would otherwise write.

import { getSettings } from './settings'
import { getCloudSession } from './session'
import { getMachineId, getMachineName } from './machine-id'
import { requireProfileId } from './validation'
import { dbg } from './dbg'

const RPC_TIMEOUT_MS = 12_000
/** Per-attempt budget for the claim (retried); a 12 s hang ×3 would stall every open. */
const CLAIM_ATTEMPT_TIMEOUT_MS = 5_000
const CLAIM_ATTEMPTS = 3
/** A heartbeat younger than this means a LIVE holder (mirrors profile-locks.sql's 30 s). */
export const HEARTBEAT_FRESH_MS = 30_000

export const SAVING_PREFIX = 'saving:'
export const FAILED_PREFIX = 'failed:'

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

/** A read-only view of the lock row (REST select, never bumps the epoch). */
export interface LockRow {
  epoch: number | null
  holderDevice: string | null
  holderName: string | null
  /** Milliseconds since epoch of the holder's last heartbeat (server clock), or null. */
  heartbeatAt: number | null
  sessionTag: string | null
}

type RpcReason = 'signed-out' | 'timeout' | 'network' | `http:${number}`

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

/** Returns { ok, value, reason }: ok=false marks a failure (network / non-2xx / not signed in)
 *  with a machine-readable reason, so callers can distinguish "the RPC failed" (log + warn)
 *  from "the RPC legitimately returned null" and from "not signed in" (silent local-only). */
async function rpc(
  fn: string,
  body: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS
): Promise<{ ok: boolean; value: unknown; reason: RpcReason | null }> {
  const c = await creds()
  if (!c) return { ok: false, value: null, reason: 'signed-out' }
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
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      dbg(`[lock] rpc ${fn} http=${res.status}`)
      return { ok: false, value: null, reason: `http:${res.status}` }
    }
    const text = await res.text()
    return { ok: true, value: text ? JSON.parse(text) : null, reason: null }
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError'
    dbg(`[lock] rpc ${fn} ${timeout ? 'timeout' : 'network'}: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, value: null, reason: timeout ? 'timeout' : 'network' } // fail-open
  }
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Become the holder of this profile's lock (bumps the epoch). Retries transient failures
 *  (a not-yet-refreshed token right after wake, a Wi-Fi reconnect, a 5xx) before giving up.
 *  `result` is null when locking is unavailable — `reason` says why: 'signed-out' is the
 *  legitimate local-only case; anything else means the open runs WITHOUT cross-machine
 *  protection while signed in, and the caller must say so. */
export async function claimProfileLock(
  id: string,
  opts: { attempts?: number } = {}
): Promise<{ result: ClaimResult | null; reason: RpcReason | 'malformed' | null }> {
  const pid = requireProfileId(id)
  const attempts = Math.max(1, Math.min(CLAIM_ATTEMPTS, opts.attempts ?? CLAIM_ATTEMPTS))
  let lastReason: RpcReason | 'malformed' | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const t0 = Date.now()
    const { ok, value, reason } = await rpc(
      'claim_profile_lock',
      { p_profile_id: pid, p_device: getMachineId(), p_name: getMachineName() },
      CLAIM_ATTEMPT_TIMEOUT_MS
    )
    if (ok && value != null) {
      const row = Array.isArray(value) ? value[0] : value
      const rec = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
      const epoch = toNum(rec.my_epoch)
      if (epoch != null) {
        const previousHolder =
          typeof rec.previous_holder === 'string' && rec.previous_holder ? rec.previous_holder : null
        const result = { epoch, previousHolder, previousFresh: rec.previous_fresh === true }
        dbg(
          `[lock ${pid}] claim ok epoch=${epoch} prev=${previousHolder ?? '-'} fresh=${result.previousFresh} attempt=${attempt} ${Date.now() - t0}ms`
        )
        return { result, reason: null }
      }
      lastReason = 'malformed'
    } else {
      lastReason = reason ?? 'network'
    }
    if (lastReason === 'signed-out') break // nothing to retry
    dbg(`[lock ${pid}] claim FAILED (${lastReason}) attempt=${attempt}/${attempts} ${Date.now() - t0}ms`)
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt))
  }
  return { result: null, reason: lastReason }
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
export async function releaseProfileLock(id: string, epoch: number): Promise<boolean> {
  const { ok } = await rpc('release_profile_lock', { p_profile_id: requireProfileId(id), p_epoch: epoch })
  dbg(`[lock ${id}] release epoch=${epoch} ok=${ok}`)
  return ok
}

/** After a machine uploads its final session, record the cloud ETag for the epoch that now
 *  holds the profile (the kicker's epoch, or — for a normal close that raced a new claim — the
 *  current epoch), so the waiting open knows the fresh session is ready. The server gates on
 *  the epoch, so a straggler from an older cycle cannot satisfy a newer claimer's wait. */
export async function publishSessionTag(id: string, forEpoch: number, tag: string): Promise<boolean> {
  if (!tag) return false
  const { ok } = await rpc('set_lock_session_tag', {
    p_profile_id: requireProfileId(id),
    p_epoch: forEpoch,
    p_tag: tag.slice(0, 512)
  })
  dbg(`[lock ${id}] publish tag for epoch=${forEpoch} ok=${ok} tag=${tag.slice(0, 24)}…`)
  return ok
}

/** "Still saving" heartbeat for the claimer: refresh `saving:<n>` (n must increase) every few
 *  seconds while the kicked side flushes + uploads. Ignored by the server once the epoch moves on. */
export async function publishSavingMarker(id: string, forEpoch: number, seq: number): Promise<void> {
  await rpc('set_lock_session_tag', {
    p_profile_id: requireProfileId(id),
    p_epoch: forEpoch,
    p_tag: `${SAVING_PREFIX}${seq}`
  })
}

/** Tell the claimer the save FAILED (so it stops waiting and can warn the user). */
export async function publishFailedMarker(id: string, forEpoch: number, reason: string): Promise<void> {
  const safe = reason.replace(/[^\p{L}\p{N} .,:;_()/-]/gu, '').slice(0, 200)
  await rpc('set_lock_session_tag', {
    p_profile_id: requireProfileId(id),
    p_epoch: forEpoch,
    p_tag: `${FAILED_PREFIX}${safe}`
  })
  dbg(`[lock ${id}] published FAILED marker for epoch=${forEpoch}: ${safe}`)
}

/** Read-only view of the lock row (never bumps the epoch). `ok:false` = could not read
 *  (`reason` says why). `timeoutMs` lets the open path keep a dead network from stalling. */
export async function peekProfileLock(
  id: string,
  timeoutMs = RPC_TIMEOUT_MS
): Promise<{ ok: boolean; row: LockRow | null; reason: RpcReason | null }> {
  const c = await creds()
  if (!c) return { ok: false, row: null, reason: 'signed-out' }
  try {
    const url =
      `${c.url}/rest/v1/profile_locks?owner=eq.${encodeURIComponent(c.uid)}` +
      `&profile_id=eq.${encodeURIComponent(requireProfileId(id))}` +
      `&select=epoch,holder_device,holder_name,heartbeat_at,session_tag`
    const res = await fetch(url, {
      headers: { apikey: c.anon, Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      dbg(`[lock ${id}] peek http=${res.status}`)
      return { ok: false, row: null, reason: `http:${res.status}` }
    }
    const rows = (await res.json()) as Array<Record<string, unknown>>
    const r = rows?.[0]
    if (!r) return { ok: true, row: null, reason: null }
    const hb = typeof r.heartbeat_at === 'string' ? Date.parse(r.heartbeat_at) : NaN
    return {
      ok: true,
      reason: null,
      row: {
        epoch: toNum(r.epoch),
        holderDevice: typeof r.holder_device === 'string' ? r.holder_device : null,
        holderName: typeof r.holder_name === 'string' ? r.holder_name : null,
        heartbeatAt: Number.isFinite(hb) ? hb : null,
        sessionTag: typeof r.session_tag === 'string' ? r.session_tag : null
      }
    }
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError'
    dbg(`[lock ${id}] peek failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, row: null, reason: timeout ? 'timeout' : 'network' }
  }
}

/** True when `row` shows a LIVE holder (fresh heartbeat by the server clock vs. `now`) that is
 *  NOT the open running in this app instance. `runningHere` = whether THIS app has the profile
 *  open: a fresh holder carrying our own machine id while nothing runs here is a cloned
 *  machine id (second install / VM image) and must count as "elsewhere". */
export function heldElsewhere(row: LockRow | null, runningHere: boolean, now = Date.now()): boolean {
  if (!row || !row.holderDevice) return false
  if (row.holderDevice === getMachineId() && runningHere) return false
  return row.heartbeatAt != null && now - row.heartbeatAt < HEARTBEAT_FRESH_MS
}

/** The real session tag published onto the row of epoch `forEpoch` — i.e. a hand-off addressed
 *  to THAT open. Null when the row now belongs to a different epoch (a newer open's tag is
 *  never ours to act on), when there is only a saving/failed marker, or when unreadable. */
export async function readPublishedSessionTag(id: string, forEpoch: number): Promise<string | null> {
  const { row } = await peekProfileLock(id)
  if (!row || row.epoch !== forEpoch) return null
  const tag = row.sessionTag
  if (!tag || tag.startsWith(SAVING_PREFIX) || tag.startsWith(FAILED_PREFIX)) return null
  return tag
}

export type HandoffOutcome =
  | { status: 'ready'; tag: string; waitedMs: number }
  | { status: 'failed'; reason: string; waitedMs: number }
  | { status: 'timeout'; waitedMs: number; sawSaving: boolean }
  | { status: 'superseded'; waitedMs: number }

/**
 * The claimer waits here for the previous holder to save + publish its fresh session tag onto
 * OUR row (claim reset session_tag to null). Adaptive: `baseBudgetMs` covers a holder that has
 * not reacted yet (its poll interval + flush); once the holder reports `saving:<n>` the wait is
 * extended by 20 s from each counter move (it stops moving when the holder dies or gives up),
 * up to `savingCapMs`. While waiting we HEARTBEAT our own epoch (poll_profile_lock) so the row
 * never looks abandoned to a third machine, and we notice a newer claim ('superseded') at once.
 * Returns 'ready' with the tag, 'failed' when the holder reported a failed save, 'timeout', or
 * 'superseded'. The caller decides what to do with a stale cloud copy — and must TELL the
 * user; the close-side anti-clobber guard (cloud-data.ts) still protects a newer session from
 * being overwritten if this open turns out to have loaded a stale one.
 */
export async function waitForHandoff(
  id: string,
  epoch: number,
  baseBudgetMs: number,
  opts: { savingCapMs?: number; onProgress?: (msg: string) => void } = {}
): Promise<HandoffOutcome> {
  const start = Date.now()
  const savingCap = opts.savingCapMs ?? 180_000
  let deadline = start + baseBudgetMs
  let lastSaving = ''
  let sawSaving = false
  let lastHeartbeat = start
  while (Date.now() < deadline) {
    const { row } = await peekProfileLock(id)
    if (row && row.epoch != null && row.epoch !== epoch) {
      return { status: 'superseded', waitedMs: Date.now() - start }
    }
    const tag = row?.sessionTag ?? null
    if (tag && tag.startsWith(FAILED_PREFIX)) {
      return { status: 'failed', reason: tag.slice(FAILED_PREFIX.length), waitedMs: Date.now() - start }
    }
    if (tag && tag.startsWith(SAVING_PREFIX)) {
      sawSaving = true
      if (tag !== lastSaving) {
        lastSaving = tag
        const changedAt = Date.now()
        // The counter moved → the holder is alive and still saving → 20 s more from THIS move
        // (computed once per move, so a dead holder's last marker buys exactly 20 s).
        deadline = Math.min(start + savingCap, Math.max(deadline, changedAt + 20_000))
        opts.onProgress?.('Máy khác đang lưu phiên… (đang chờ để lấy bản mới nhất)')
      }
    } else if (tag) {
      return { status: 'ready', tag, waitedMs: Date.now() - start }
    }
    if (Date.now() - lastHeartbeat >= 10_000) {
      lastHeartbeat = Date.now()
      const poll = await pollProfileLock(id, epoch)
      if (poll.ok && poll.epoch != null && poll.epoch !== epoch) {
        return { status: 'superseded', waitedMs: Date.now() - start }
      }
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  return { status: 'timeout', waitedMs: Date.now() - start, sawSaving }
}
