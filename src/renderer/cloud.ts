// ── VGC Browser — Supabase cloud client (renderer) ───────────────────────────
// Lazily builds a Supabase client from the URL + anon key the user pastes into
// Settings. Auth + sync run in the renderer (supabase-js is browser-native);
// the session persists in localStorage under a VGC-specific key.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Profile, SavedProxy } from '../shared/types'

let client: SupabaseClient | null = null
let signature = ''

/** Returns the client, or null if Supabase isn't configured yet. */
export async function getCloud(): Promise<SupabaseClient | null> {
  const s = await window.vgc.getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return null
  const sig = `${s.supabaseUrl}|${s.supabaseAnonKey}`
  if (!client || signature !== sig) {
    client = createClient(s.supabaseUrl, s.supabaseAnonKey, {
      auth: { persistSession: true, storageKey: 'vgc-cloud-auth', autoRefreshToken: true }
    })
    signature = sig
  }
  return client
}

/**
 * Pull the account's profile LIST (metadata) from `profiles_cloud` into the local
 * store. Used both on login (auto, GoLogin-style) and by the Cloud modal's manual
 * "Kéo về" button. Returns the number of profiles pulled, or -1 when cloud isn't
 * configured / the user isn't signed in.
 *
 * Session DATA (cookies/logins/storage) is intentionally NOT downloaded here — it
 * syncs lazily when a profile is actually opened (see profile-manager), so login
 * stays fast even for accounts with many heavy profiles.
 */
// Encrypt a record's `data` payload with the per-account secret before it goes into
// the cloud DB, so cookies / proxy passwords aren't plaintext jsonb. Stores `{ enc }`
// when a secret exists; raw object pre-migration (so nothing breaks during rollout).
async function protectData(context: string, obj: unknown): Promise<unknown> {
  const enc = await window.vgc.cloudProtect(context, JSON.stringify(obj))
  return enc ? { enc } : obj
}
// Inverse: decode a stored `data` value (encrypted `{ enc }` or legacy plaintext).
async function unprotectData<T>(context: string, data: unknown): Promise<T | null> {
  if (data && typeof data === 'object' && typeof (data as { enc?: unknown }).enc === 'string') {
    const dec = await window.vgc.cloudUnprotect(context, (data as { enc: string }).enc)
    return dec ? (JSON.parse(dec) as T) : null
  }
  return (data ?? null) as T | null
}

export async function pullCloudProfileList(): Promise<number> {
  const c = await getCloud()
  if (!c) return -1
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return -1

  // Prefer the tombstone-aware query (needs the `deleted` column from
  // supabase/add-soft-delete.sql). If that column doesn't exist yet, fall back to
  // the plain pull so the app still works before the migration is run.
  const withDel = await c.from('profiles_cloud').select('profile_id,data,deleted')
  if (withDel.error) {
    const plain = await c.from('profiles_cloud').select('data')
    if (plain.error) throw new Error(plain.error.message)
    const profiles = (
      await Promise.all(
        (plain.data ?? []).map((r) => unprotectData<Profile>('profile', (r as { data: unknown }).data))
      )
    ).filter((p): p is Profile => !!p)
    await window.vgc.bulkUpsertProfiles(profiles)
    return profiles.length
  }

  const rows = (withDel.data ?? []) as Array<{ profile_id: string; data: unknown; deleted?: boolean }>
  const live = (
    await Promise.all(
      rows.filter((r) => !r.deleted).map((r) => unprotectData<Profile>('profile', r.data))
    )
  ).filter((p): p is Profile => !!p)
  const deletedIds = rows.filter((r) => r.deleted).map((r) => r.profile_id)
  await window.vgc.bulkUpsertProfiles(live)
  // Don't let a just-pulled profile look "changed" to the next push — it would echo
  // it straight back, bumping updated_at and ping-ponging with the other machine.
  for (const p of live) lastPushedAt.set(p.id, p.updatedAt)
  // Apply deletions from other machines: a profile tombstoned in the cloud is
  // removed locally so it stops re-appearing on every "Làm mới".
  if (deletedIds.length) await window.vgc.removeProfiles(deletedIds)
  return live.length
}

/**
 * Mark a profile as deleted in the cloud (a tombstone) so the deletion propagates
 * to the account's other machines. We tombstone instead of hard-deleting the row
 * because another machine that still has the profile locally would otherwise
 * re-create it on its next auto-push — the tombstone survives that push (the push
 * never sets `deleted`) and tells every machine to drop the profile on pull.
 *
 * If the `deleted` column doesn't exist yet (migration not run), we hard-delete the
 * row as a best-effort fallback. Also removes the heavy session zip from Storage.
 */
export async function deleteCloudProfile(id: string): Promise<void> {
  const c = await getCloud()
  if (!c) return
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return
  const owner = sess.session.user.id
  const upd = await c
    .from('profiles_cloud')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('owner', owner)
    .eq('profile_id', id)
  if (upd.error) {
    // Column missing (pre-migration) → fall back to a hard delete.
    await c.from('profiles_cloud').delete().eq('owner', owner).eq('profile_id', id)
  }
  // Drop the session data zip regardless (best-effort; ignore failures).
  try {
    await c.storage.from('profiles').remove([`${owner}/${id}.zip`])
  } catch {
    // ignore
  }
}

/**
 * Push the account's profile LIST (metadata) to `profiles_cloud` so new/edited
 * profiles appear on the user's other machines WITHOUT a manual "Đẩy lên". This is
 * the lightweight half of the Cloud modal's push: it upserts metadata only and does
 * NOT zip+upload session data (that still happens on profile close). Idempotent —
 * re-pushing unchanged profiles just bumps `updated_at`.
 *
 * Returns the number of rows pushed, or -1 when cloud isn't configured / signed out.
 */
export async function pushCloudProfileList(): Promise<number> {
  const c = await getCloud()
  if (!c) return -1
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return -1
  const owner = sess.session.user.id
  const locals = await window.vgc.listProfiles()
  if (!locals.length) return 0
  // Only push profiles whose `updatedAt` changed since we last pushed them this
  // session. Opening a profile bumps `lastUsedAt` but NOT `updatedAt` (see
  // store.saveProfile), so an open no longer re-pushes the profile's full data —
  // which previously could overwrite another machine's genuine edit with this
  // machine's stale copy (last-writer-wins). First push of a session sends all
  // (the map is empty), keeping the cloud complete.
  const changed = locals.filter((p) => lastPushedAt.get(p.id) !== p.updatedAt)
  if (!changed.length) return 0
  const rows = await Promise.all(
    changed.map(async (p) => ({
      owner,
      team_id: p.cloudTeamId || null,
      profile_id: p.id,
      name: p.name,
      data: await protectData('profile', p),
      updated_at: new Date().toISOString()
    }))
  )
  const { error } = await c.from('profiles_cloud').upsert(rows, { onConflict: 'owner,profile_id' })
  if (error) throw new Error(error.message)
  for (const p of changed) lastPushedAt.set(p.id, p.updatedAt)
  return rows.length
}

/** Per-session memory of the `updatedAt` we last pushed for each profile, so a
 *  push skips profiles that only had `lastUsedAt` bumped (e.g. by opening them). */
const lastPushedAt = new Map<string, string>()

/**
 * Apply ONLY cloud tombstones (deletions) locally, without pulling/overwriting
 * live profile data. Safe to run even while a local edit-push is pending: a
 * deletion can't clobber an unpushed edit, and this is what stops a profile
 * deleted on another machine from lingering (or being re-pushed) on a machine
 * that's continuously editing (where the full auto-pull is paused). Returns the
 * count removed, or -1 when not signed in / cloud not configured.
 */
export async function applyCloudTombstones(): Promise<number> {
  const c = await getCloud()
  if (!c) return -1
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return -1
  const res = await c.from('profiles_cloud').select('profile_id,deleted').eq('deleted', true)
  if (res.error) return 0 // pre-migration: no `deleted` column → nothing to apply
  const ids = (res.data ?? []).map((r) => (r as { profile_id: string }).profile_id)
  if (ids.length) await window.vgc.removeProfiles(ids)
  return ids.length
}

/**
 * Pull the account's proxy pool (Proxy Manager) from `proxies_cloud` into the local
 * store. Mirrors pullCloudProfileList. Returns the number pulled, or -1 when cloud
 * isn't configured / the user isn't signed in.
 */
export async function pullCloudProxies(): Promise<number> {
  const c = await getCloud()
  if (!c) return -1
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return -1

  const withDel = await c.from('proxies_cloud').select('proxy_id,data,deleted')
  if (withDel.error) {
    const plain = await c.from('proxies_cloud').select('data')
    if (plain.error) throw new Error(plain.error.message)
    const proxies = (
      await Promise.all(
        (plain.data ?? []).map((r) => unprotectData<SavedProxy>('proxy', (r as { data: unknown }).data))
      )
    ).filter((p): p is SavedProxy => !!p)
    await window.vgc.saveManyProxies(proxies)
    return proxies.length
  }

  const rows = (withDel.data ?? []) as Array<{ proxy_id: string; data: unknown; deleted?: boolean }>
  const live = (
    await Promise.all(
      rows.filter((r) => !r.deleted).map((r) => unprotectData<SavedProxy>('proxy', r.data))
    )
  ).filter((p): p is SavedProxy => !!p)
  const deletedIds = rows.filter((r) => r.deleted).map((r) => r.proxy_id)
  await window.vgc.saveManyProxies(live)
  if (deletedIds.length) await window.vgc.removeProxies(deletedIds)
  return live.length
}

/** Tombstone a proxy in the cloud so the deletion syncs to other machines.
 * Mirrors deleteCloudProfile; hard-deletes as a fallback before the migration. */
export async function deleteCloudProxy(id: string): Promise<void> {
  const c = await getCloud()
  if (!c) return
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return
  const owner = sess.session.user.id
  const upd = await c
    .from('proxies_cloud')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('owner', owner)
    .eq('proxy_id', id)
  if (upd.error) {
    await c.from('proxies_cloud').delete().eq('owner', owner).eq('proxy_id', id)
  }
}

/**
 * Push the account's proxy pool to `proxies_cloud` so a proxy added on one machine
 * appears on the account's other machines automatically. Mirrors pushCloudProfileList.
 * Returns the number pushed, or -1 when cloud isn't configured / signed out.
 */
export async function pushCloudProxies(): Promise<number> {
  const c = await getCloud()
  if (!c) return -1
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return -1
  const owner = sess.session.user.id
  const locals = await window.vgc.listProxies()
  if (!locals.length) return 0
  const rows = await Promise.all(
    locals.map(async (p) => ({
      owner,
      proxy_id: p.id,
      label: p.label,
      data: await protectData('proxy', p),
      updated_at: new Date().toISOString()
    }))
  )
  const { error } = await c.from('proxies_cloud').upsert(rows, { onConflict: 'owner,proxy_id' })
  if (error) throw new Error(error.message)
  return rows.length
}
