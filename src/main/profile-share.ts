// ── VGC Browser — profile sharing (share a profile to another email) ─────────
// A profile owned by A can be shared with member emails. Each shared profile gets
// a random SHARED key (stored in `profile_shares`, readable by owner + member via
// RLS) so BOTH sides can AES-decrypt the synced data — the per-account secret can't
// be used cross-account. The owner also attaches a `proxy` the shared copy uses.
//
// Run supabase/profile-shares.sql once for the table + policies to exist.

import { randomBytes } from 'crypto'
import { getCloudSession, getCloudEmail } from './session'
import { getSettings } from './settings'
import type { ProxyConfig } from '../shared/types'

interface ShareRow {
  profile_id: string
  owner: string
  member_email: string
  shared_key: string
  proxy: ProxyConfig | null
}

let cache: { uid: string; rows: ShareRow[]; at: number } | null = null
// A recipient's cache is only invalidated locally (shareProfile/unshareProfile run
// on the OWNER's machine), so without a TTL a recipient would never see a newly
// shared profile. 30s keeps it fresh without hammering the REST endpoint.
const CACHE_TTL_MS = 30_000

async function rest(
  pathAndQuery: string,
  init?: { method?: string; body?: string; prefer?: string }
): Promise<Response | null> {
  const session = getCloudSession()
  if (!session) return null
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return null
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    apikey: s.supabaseAnonKey,
    'Content-Type': 'application/json'
  }
  if (init?.prefer) headers.Prefer = init.prefer
  try {
    return await fetch(`${s.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body
    })
  } catch {
    return null
  }
}

/** All share rows visible to me (RLS: ones I own + ones addressed to my email). */
export async function loadShares(force = false): Promise<ShareRow[]> {
  const session = getCloudSession()
  if (!session) return []
  if (
    !force &&
    cache &&
    cache.uid === session.uid &&
    Date.now() - cache.at < CACHE_TTL_MS
  ) {
    return cache.rows
  }
  const res = await rest('profile_shares?select=profile_id,owner,member_email,shared_key,proxy')
  if (!res || !res.ok) return cache?.uid === session.uid ? cache.rows : []
  const rows = (await res.json().catch(() => [])) as ShareRow[]
  cache = { uid: session.uid, rows: Array.isArray(rows) ? rows : [], at: Date.now() }
  return cache.rows
}

export function invalidateShareCache(): void {
  cache = null
}

/** The shared key for a profile (owner or member). null → use the account secret. */
export async function getProfileKey(profileId: string): Promise<string | null> {
  const rows = await loadShares()
  const r = rows.find((x) => x.profile_id === profileId)
  return r ? r.shared_key : null
}

/** The uid whose cloud folder holds this profile's data. For a shared profile that
 *  is ALWAYS the owner (both owner and members read/write the same
 *  `profiles/{owner}/{id}` path so two-way sync converges); otherwise it's the
 *  current user. Returns null only when signed out. */
export async function ownerForProfile(profileId: string): Promise<string | null> {
  const session = getCloudSession()
  if (!session) return null
  const rows = await loadShares()
  const r = rows.find((x) => x.profile_id === profileId)
  return r ? r.owner : session.uid
}

/** Share a profile to an email with a chosen proxy. Reuses the profile's existing
 *  shared key when it's already shared (so every member decrypts the same data). */
export async function shareProfile(
  profileId: string,
  email: string,
  proxy: ProxyConfig | null
): Promise<{ ok: boolean; error?: string }> {
  const session = getCloudSession()
  if (!session) return { ok: false, error: 'Chưa đăng nhập cloud' }
  const member = email.trim().toLowerCase()
  if (!member || !member.includes('@')) return { ok: false, error: 'Email không hợp lệ' }

  const rows = await loadShares(true)
  const mine = rows.find((x) => x.profile_id === profileId && x.owner === session.uid)
  const sharedKey = mine?.shared_key ?? randomBytes(32).toString('hex')

  const res = await rest('profile_shares', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: JSON.stringify({
      profile_id: profileId,
      owner: session.uid,
      member_email: member,
      shared_key: sharedKey,
      proxy: proxy ?? null
    })
  })
  invalidateShareCache()
  if (!res || !res.ok) {
    const detail = res ? await res.text().catch(() => '') : ''
    if (detail.includes('relation') && detail.includes('profile_shares')) {
      return { ok: false, error: 'Chưa tạo bảng chia sẻ — hãy chạy supabase/profile-shares.sql.' }
    }
    return { ok: false, error: `Chia sẻ lỗi: ${detail || 'không rõ'}` }
  }
  return { ok: true }
}

/** Emails a profile is shared with (owner view). */
export async function listShares(profileId: string): Promise<Array<{ email: string }>> {
  const session = getCloudSession()
  if (!session) return []
  const rows = await loadShares()
  return rows
    .filter((x) => x.profile_id === profileId && x.owner === session.uid)
    .map((x) => ({ email: x.member_email }))
}

/** Stop sharing a profile with one email (owner). */
export async function unshareProfile(profileId: string, email: string): Promise<void> {
  const session = getCloudSession()
  if (!session) return
  await rest(
    `profile_shares?profile_id=eq.${encodeURIComponent(profileId)}&owner=eq.${session.uid}&member_email=eq.${encodeURIComponent(email.toLowerCase())}`,
    { method: 'DELETE' }
  )
  invalidateShareCache()
}

/** Profiles shared WITH me (member view): the ids + chosen proxy to import/sync. */
export async function getSharedWithMe(): Promise<
  Array<{ profileId: string; owner: string; proxy: ProxyConfig | null }>
> {
  const session = getCloudSession()
  if (!session) return []
  const email = getCloudEmail()
  const rows = await loadShares()
  return rows
    .filter((x) => x.member_email === email && x.owner !== session.uid)
    .map((x) => ({ profileId: x.profile_id, owner: x.owner, proxy: x.proxy }))
}
