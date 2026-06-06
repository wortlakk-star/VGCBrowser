// ── VGC Browser — Supabase cloud client (renderer) ───────────────────────────
// Lazily builds a Supabase client from the URL + anon key the user pastes into
// Settings. Auth + sync run in the renderer (supabase-js is browser-native);
// the session persists in localStorage under a VGC-specific key.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '../shared/types'

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
export async function pullCloudProfileList(): Promise<number> {
  const c = await getCloud()
  if (!c) return -1
  const { data: sess } = await c.auth.getSession()
  if (!sess.session) return -1
  const { data, error } = await c.from('profiles_cloud').select('data')
  if (error) throw new Error(error.message)
  const profiles = (data ?? []).map((r) => (r as { data: Profile }).data)
  await window.vgc.bulkUpsertProfiles(profiles)
  return profiles.length
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
  const rows = locals.map((p) => ({
    owner,
    team_id: p.cloudTeamId || null,
    profile_id: p.id,
    name: p.name,
    data: p,
    updated_at: new Date().toISOString()
  }))
  const { error } = await c.from('profiles_cloud').upsert(rows, { onConflict: 'owner,profile_id' })
  if (error) throw new Error(error.message)
  return rows.length
}
