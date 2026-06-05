// ── VGC Browser — current cloud session (main) ───────────────────────────────
// Single source of truth for the logged-in Supabase session in the main process.
// Kept in its own module so both store.ts (per-account profile storage) and
// cloud-data.ts (per-account Storage sync) can read it without a circular import.

import type { CloudSession } from '../shared/types'

let session: CloudSession | null = null

/** Renderer (Gate) hands us its live access token + uid, refreshed on change. */
export function setCloudSession(s: CloudSession | null): void {
  session = s
}

export function getCloudSession(): CloudSession | null {
  return session
}

/** Key used to namespace per-account local storage. 'local' when signed out. */
export function accountKey(): string {
  return session?.uid ?? 'local'
}
