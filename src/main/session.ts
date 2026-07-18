// ── VGC Browser — current cloud session (main) ───────────────────────────────
// Single source of truth for the logged-in Supabase session in the main process.
// Kept in its own module so both store.ts (per-account profile storage) and
// cloud-data.ts (per-account Storage sync) can read it without a circular import.

import type { CloudSession } from '../shared/types'
import { refreshLicense, reportRegistration } from './license'

let session: CloudSession | null = null

/** Renderer (Gate) hands us its live access token + uid, refreshed on change. */
export function setCloudSession(s: CloudSession | null): void {
  session = s
  // Re-check the admin allowlist whenever the login changes (approved emails only)...
  void refreshLicense(getCloudEmail())
  // ...and report the sign-in (email + machine + country) to the admin panel so new
  // registrations show up there to be approved.
  void reportRegistration(getCloudEmail())
}

export function getCloudSession(): CloudSession | null {
  return session
}

/** The signed-in user's email, decoded from the access-token JWT (used to match
 *  profile shares addressed to this email). null when signed out / unparseable. */
export function getCloudEmail(): string | null {
  const tok = session?.accessToken
  if (!tok) return null
  try {
    const payload = tok.split('.')[1]
    const json = Buffer.from(payload, 'base64').toString('utf-8')
    const email = (JSON.parse(json) as { email?: string }).email
    return email ?? null
  } catch {
    return null
  }
}

/** Key used to namespace per-account local storage. 'local' when signed out. */
export function accountKey(): string {
  return session?.uid ?? 'local'
}
