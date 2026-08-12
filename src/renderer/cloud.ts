// ── VGC Browser — Supabase cloud client (renderer) ───────────────────────────
// Lazily builds a Supabase client from the release-pinned URL + publishable key.
// Auth + sync run in the renderer (supabase-js is browser-native); the
// session persists through the preload-backed encrypted auth store.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Profile, SavedProxy } from '../shared/types'

let client: SupabaseClient | null = null
let signature = ''
const AUTH_STORAGE_KEY = 'vgc-cloud-auth'

/** Returns the client, or null if Supabase isn't configured yet. */
export async function getCloud(): Promise<SupabaseClient | null> {
  const s = await window.vgc.getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return null
  const sig = `${s.supabaseUrl}|${s.supabaseAnonKey}`
  if (!client || signature !== sig) {
    const legacy = localStorage.getItem(AUTH_STORAGE_KEY)
    if (legacy) {
      await window.vgc.cloudAuthSet(AUTH_STORAGE_KEY, legacy)
      localStorage.removeItem(AUTH_STORAGE_KEY)
    }
    client = createClient(s.supabaseUrl, s.supabaseAnonKey, {
      auth: {
        persistSession: true,
        storageKey: AUTH_STORAGE_KEY,
        autoRefreshToken: true,
        storage: {
          getItem: (key) => window.vgc.cloudAuthGet(key),
          setItem: (key, value) => window.vgc.cloudAuthSet(key, value),
          removeItem: (key) => window.vgc.cloudAuthRemove(key)
        }
      }
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
// Encrypt every `data` payload before it reaches PostgREST. Missing key material is a
// hard error: cloud sync must never silently downgrade to plaintext.
async function protectData(
  context: 'profile' | 'proxy',
  obj: unknown,
  expectedUid: string,
  profileId?: string
): Promise<{ enc: string }> {
  const enc = await window.vgc.cloudProtect(context, JSON.stringify(obj), expectedUid, profileId)
  if (!enc) throw new Error('VGC_ENCRYPTION_KEY_REQUIRED')
  return { enc }
}
// Inverse: only encrypted envelopes are accepted here. Legacy plaintext is handled by
// the owner-only migration helper below and is never accepted from another account.
async function unprotectData<T>(
  context: 'profile' | 'proxy',
  data: unknown,
  expectedUid: string,
  profileId?: string
): Promise<{ value: T; legacy: boolean } | null> {
  if (data && typeof data === 'object' && typeof (data as { enc?: unknown }).enc === 'string') {
    const dec = await window.vgc.cloudUnprotect(
      context,
      (data as { enc: string }).enc,
      expectedUid,
      profileId
    )
    if (!dec) throw new Error('Không giải mã được dữ liệu cloud. Kiểm tra passphrase.')
    try {
      return { value: JSON.parse(dec.plaintext) as T, legacy: dec.legacy }
    } catch {
      throw new Error('Dữ liệu cloud sau giải mã không đúng định dạng.')
    }
  }
  return null
}

interface LegacyCloudRow {
  owner: string
  data: unknown
}

async function decodeOrMigrateLegacy<T>(
  c: SupabaseClient,
  table: 'profiles_cloud' | 'proxies_cloud',
  idColumn: 'profile_id' | 'proxy_id',
  id: string,
  context: 'profile' | 'proxy',
  row: LegacyCloudRow,
  currentUid: string,
  profileId?: string
): Promise<T | null> {
  const decoded = await unprotectData<T>(context, row.data, currentUid, profileId)
  if (decoded) {
    if (decoded.legacy) {
      const envelope = await protectData(context, decoded.value, currentUid, profileId)
      const { error } = await c
        .from(table)
        .update({ data: envelope, updated_at: new Date().toISOString() })
        .eq('owner', currentUid)
        .eq(idColumn, id)
      if (error) throw new Error(`Không thể nâng cấp mã hoá cloud: ${error.message}`)
    }
    return decoded.value
  }
  if (
    row.owner !== currentUid ||
    !row.data ||
    typeof row.data !== 'object' ||
    Array.isArray(row.data) ||
    'enc' in row.data
  ) {
    return null
  }

  const envelope = await protectData(context, row.data, currentUid, profileId)
  const { error } = await c
    .from(table)
    .update({ data: envelope, updated_at: new Date().toISOString() })
    .eq('owner', currentUid)
    .eq(idColumn, id)
  if (error) throw new Error(`Không thể mã hoá dữ liệu cloud cũ: ${error.message}`)
  return row.data as T
}

export async function pullCloudProfileList(): Promise<number> {
  const c = await getCloud()
  if (!c) return -1
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return -1
  const uid = sess.session.user.id

  // Prefer the tombstone-aware query (needs the `deleted` column from
  // supabase/add-soft-delete.sql). If that column doesn't exist yet, fall back to
  // the plain pull so the app still works before the migration is run.
  const withDel = await c
    .from('profiles_cloud')
    .select('owner,profile_id,data,deleted')
    .limit(5000)
  if (withDel.error) {
    const plain = await c
      .from('profiles_cloud')
      .select('owner,profile_id,data')
      .limit(5000)
    if (plain.error) throw new Error(plain.error.message)
    const profiles = (
      await Promise.all(
        (plain.data ?? []).map((raw) => {
          const r = raw as { owner: string; profile_id: string; data: unknown }
          return decodeOrMigrateLegacy<Profile>(
            c,
            'profiles_cloud',
            'profile_id',
            r.profile_id,
            'profile',
            r,
            uid,
            r.profile_id
          )
        })
      )
    ).filter((p): p is Profile => !!p)
    await window.vgc.bulkUpsertProfiles(profiles, uid)
    return profiles.length
  }

  const rows = (withDel.data ?? []) as Array<{
    owner: string
    profile_id: string
    data: unknown
    deleted?: boolean
  }>
  const live = (
    await Promise.all(
      rows
        .filter((r) => !r.deleted)
        .map((r) =>
          decodeOrMigrateLegacy<Profile>(
            c,
            'profiles_cloud',
            'profile_id',
            r.profile_id,
            'profile',
            r,
            uid,
            r.profile_id
          )
        )
    )
  ).filter((p): p is Profile => !!p)
  const deletedIds = rows.filter((r) => r.deleted).map((r) => r.profile_id)
  await window.vgc.bulkUpsertProfiles(live, uid)
  // Don't let a just-pulled profile look "changed" to the next push — it would echo
  // it straight back, bumping updated_at and ping-ponging with the other machine.
  for (const p of live) lastPushedAt.set(`${uid}:${p.id}`, p.updatedAt)
  // Apply deletions from other machines: a profile tombstoned in the cloud is
  // removed locally so it stops re-appearing on every "Làm mới".
  if (deletedIds.length) await window.vgc.removeProfiles(deletedIds, uid)
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
  // Drop every per-profile object regardless (best-effort; ignore failures).
  try {
    await c.storage.from('profiles').remove([
      `${owner}/${id}.zip`,
      `${owner}/${id}.cookies.json`,
      `${owner}/${id}.passwords.json`,
      `${owner}/${id}.cookiesdb.json`
    ])
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
export async function pushCloudProfileList(force = false): Promise<number> {
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
  const changed = force
    ? locals
    : locals.filter((p) => lastPushedAt.get(`${owner}:${p.id}`) !== p.updatedAt)
  if (!changed.length) return 0
  const rows = await Promise.all(
    changed.map(async (p) => ({
      owner,
      team_id: null,
      profile_id: p.id,
      name: p.name,
      data: await protectData('profile', p, owner, p.id),
      updated_at: new Date().toISOString()
    }))
  )
  const { error } = await c.from('profiles_cloud').upsert(rows, { onConflict: 'owner,profile_id' })
  if (error) throw new Error(error.message)
  for (const p of changed) lastPushedAt.set(`${owner}:${p.id}`, p.updatedAt)
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
  if (ids.length) await window.vgc.removeProfiles(ids, sess.session.user.id)
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
  const uid = sess.session.user.id

  const withDel = await c
    .from('proxies_cloud')
    .select('owner,proxy_id,data,deleted')
    .limit(5000)
  if (withDel.error) {
    const plain = await c
      .from('proxies_cloud')
      .select('owner,proxy_id,data')
      .limit(5000)
    if (plain.error) throw new Error(plain.error.message)
    const proxies = (
      await Promise.all(
        (plain.data ?? []).map((raw) => {
          const r = raw as { owner: string; proxy_id: string; data: unknown }
          return decodeOrMigrateLegacy<SavedProxy>(
            c,
            'proxies_cloud',
            'proxy_id',
            r.proxy_id,
            'proxy',
            r,
            uid,
            r.proxy_id
          )
        })
      )
    ).filter((p): p is SavedProxy => !!p)
    await window.vgc.saveManyProxies(proxies, uid)
    return proxies.length
  }

  const rows = (withDel.data ?? []) as Array<{
    owner: string
    proxy_id: string
    data: unknown
    deleted?: boolean
  }>
  const live = (
    await Promise.all(
      rows
        .filter((r) => !r.deleted)
        .map((r) =>
          decodeOrMigrateLegacy<SavedProxy>(
            c,
            'proxies_cloud',
            'proxy_id',
            r.proxy_id,
            'proxy',
            r,
            uid,
            r.proxy_id
          )
        )
    )
  ).filter((p): p is SavedProxy => !!p)
  const deletedIds = rows.filter((r) => r.deleted).map((r) => r.proxy_id)
  await window.vgc.saveManyProxies(live, uid)
  if (deletedIds.length) await window.vgc.removeProxies(deletedIds, uid)
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
      data: await protectData('proxy', p, owner, p.id),
      updated_at: new Date().toISOString()
    }))
  )
  const { error } = await c.from('proxies_cloud').upsert(rows, { onConflict: 'owner,proxy_id' })
  if (error) throw new Error(error.message)
  return rows.length
}
