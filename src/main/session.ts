// ── VGC Browser — current cloud session (main) ───────────────────────────────
// Single source of truth for the logged-in Supabase session in the main process.
// Kept in its own module so both store.ts (per-account profile storage) and
// cloud-data.ts (per-account Storage sync) can read it without a circular import.

import type { CloudSession } from '../shared/types'
import { refreshLicense, reportRegistration } from './license'
import { isUuid } from './validation'
import { getSettings } from './settings'

let session: CloudSession | null = null

async function boundedUserResponse(res: Response): Promise<{ id?: string }> {
  const max = 64 * 1024
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > max || !res.body) throw new Error('Phản hồi xác thực cloud không hợp lệ')
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) throw new Error('Phản hồi xác thực cloud vượt giới hạn')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as { id?: string }
}

/** Verify both JWT shape and signature/ownership through Supabase. Claim-only checks
 * are insufficient because a renderer compromise could fabricate an unsigned JWT. */
export async function validateCloudSession(s: CloudSession): Promise<void> {
  if (!isUuid(s.uid) || typeof s.accessToken !== 'string' || s.accessToken.length > 16_384) {
    throw new Error('Cloud session không hợp lệ')
  }
  try {
    const parts = s.accessToken.split('.')
    if (parts.length !== 3 || parts.some((part) => !part || part.length > 12_000)) {
      throw new Error('JWT không hợp lệ')
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      sub?: string
      exp?: number
      iss?: string
      aud?: string | string[]
      role?: string
    }
    const settings = await getSettings()
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (
      payload.sub !== s.uid ||
      !payload.exp ||
      payload.exp * 1000 <= Date.now() + 30_000 ||
      payload.iss !== `${settings.supabaseUrl}/auth/v1` ||
      !audience.includes('authenticated') ||
      payload.role !== 'authenticated'
    ) {
      throw new Error('Cloud session không khớp tài khoản')
    }

    const res = await fetch(`${settings.supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${s.accessToken}`,
        apikey: settings.supabaseAnonKey
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error('Supabase từ chối cloud session')
    }
    const user = await boundedUserResponse(res)
    if (user.id !== s.uid) throw new Error('Cloud session không khớp người dùng')
  } catch {
    throw new Error('Cloud session không hợp lệ')
  }
}

/** Renderer hands us its live token. Main verifies it before allowing the uid to
 * select an account-scoped local store. */
export function commitValidatedCloudSession(s: CloudSession | null): void {
  session = s ? { uid: s.uid, accessToken: s.accessToken } : null
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
    const json = Buffer.from(payload, 'base64url').toString('utf-8')
    const email = (JSON.parse(json) as { email?: string }).email
    return typeof email === 'string' && email.length <= 320 ? email : null
  } catch {
    return null
  }
}

/** Key used to namespace per-account local storage. 'local' when signed out. */
export function accountKey(): string {
  return session?.uid ?? 'local'
}
