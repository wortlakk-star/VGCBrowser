// ── VGC Browser — Supabase cloud client (renderer) ───────────────────────────
// Lazily builds a Supabase client from the URL + anon key the user pastes into
// Settings. Auth + sync run in the renderer (supabase-js is browser-native);
// the session persists in localStorage under a VGC-specific key.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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
