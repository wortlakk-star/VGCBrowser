// ── VGC Browser — profile create/update service ──────────────────────────────
// Shared by IPC (UI) and the automation API so both create/update profiles the
// same way (defaults, fingerprint generation, timestamps).

import { randomUUID } from 'crypto'
import type { CreateProfileInput, OsType, Profile } from '../shared/types'
import { generateFingerprint } from '../shared/fingerprint'
import { patchProfile, saveProfile } from './store'

/**
 * OS to give a new profile by default = the HOST machine's OS. Matching the host is the
 * most undetectable choice: the profile's claimed GPU/Canvas can then match what the
 * engine ACTUALLY renders (Metal on Mac, D3D on Windows). A Windows profile on a Mac
 * spoofs the UA/UA-CH fine but its real WebGL/Canvas output is still Mac Metal — a deep
 * fingerprint mismatch enterprise anti-bot (wise.com's Cloudflare) catches. So a Mac
 * runs Mac profiles, a Windows box runs Windows profiles.
 */
export function hostOs(): OsType {
  return process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : 'linux'
}

export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  const now = new Date().toISOString()
  const os: OsType = input.os ?? hostOs()
  const profile: Profile = {
    id: randomUUID(),
    name: input.name?.trim() || 'Profile mới',
    notes: input.notes ?? '',
    tags: input.tags ?? [],
    group: input.group,
    os,
    fingerprint: input.fingerprint ?? generateFingerprint(os),
    proxy: input.proxy ?? { type: 'none' },
    startUrls: input.startUrls ?? [],
    createdAt: now,
    updatedAt: now
  }
  return saveProfile(profile)
}

export async function updateProfile(id: string, patch: Partial<Profile>): Promise<Profile> {
  // Never let a patch rewrite id/createdAt; apply atomically (read-modify-write inside
  // the store lock) so a concurrent edit to other fields isn't lost.
  const { id: _ignoreId, createdAt: _ignoreCreated, ...safe } = patch
  const updated = await patchProfile(id, { ...safe, updatedAt: new Date().toISOString() })
  if (!updated) throw new Error(`Không tìm thấy profile: ${id}`)
  return updated
}
