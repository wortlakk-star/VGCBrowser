// Cross-account sharing is intentionally disabled. The previous design stored one
// symmetric key in a row readable by every participant, which provided no revocation
// or per-recipient key isolation. Re-enable only with authenticated public keys and a
// separate encrypted key envelope for each recipient.

import type { ProxyConfig } from '../shared/types'
import { getCloudSession } from './session'

const SHARING_DISABLED =
  'Chia sẻ profile đang tạm khóa để nâng cấp trao đổi khoá đầu-cuối theo từng người nhận.'

export async function getProfileKey(_profileId: string): Promise<string | null> {
  return null
}

export async function ownerForProfile(_profileId: string): Promise<string | null> {
  return getCloudSession()?.uid ?? null
}

export async function shareProfile(
  _profileId: string,
  _email: string,
  _proxy: ProxyConfig | null
): Promise<{ ok: boolean; error?: string }> {
  return { ok: false, error: SHARING_DISABLED }
}

export async function listShares(_profileId: string): Promise<Array<{ email: string }>> {
  return []
}

export async function unshareProfile(_profileId: string, _email: string): Promise<void> {
  // Legacy rows are revoked by supabase/profile-shares.sql.
}

export async function getSharedWithMe(): Promise<
  Array<{ profileId: string; owner: string; proxy: ProxyConfig | null }>
> {
  return []
}
