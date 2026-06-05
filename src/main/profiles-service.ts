// ── VGC Browser — profile create/update service ──────────────────────────────
// Shared by IPC (UI) and the automation API so both create/update profiles the
// same way (defaults, fingerprint generation, timestamps).

import { randomUUID } from 'crypto'
import type { CreateProfileInput, Profile } from '../shared/types'
import { generateFingerprint } from '../shared/fingerprint'
import { getProfile, saveProfile } from './store'

export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  const now = new Date().toISOString()
  const profile: Profile = {
    id: randomUUID(),
    name: input.name?.trim() || 'Profile mới',
    notes: input.notes ?? '',
    tags: input.tags ?? [],
    group: input.group,
    os: input.os ?? 'windows',
    fingerprint: input.fingerprint ?? generateFingerprint(input.os ?? 'windows'),
    proxy: input.proxy ?? { type: 'none' },
    startUrls: input.startUrls ?? [],
    createdAt: now,
    updatedAt: now
  }
  return saveProfile(profile)
}

export async function updateProfile(id: string, patch: Partial<Profile>): Promise<Profile> {
  const current = await getProfile(id)
  if (!current) throw new Error(`Không tìm thấy profile: ${id}`)
  const updated: Profile = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString()
  }
  return saveProfile(updated)
}
