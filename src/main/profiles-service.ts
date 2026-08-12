// ── VGC Browser — profile create/update service ──────────────────────────────
// Shared by IPC (UI) and the automation API so both create/update profiles the
// same way (defaults, fingerprint generation, timestamps).

import { randomUUID } from 'crypto'
import type { CreateProfileInput, OsType, Profile } from '../shared/types'
import { patchProfile, saveProfile } from './store'
import { cohereFingerprint, hostOs, hostFingerprintEnvironment } from './host-fingerprint'
import {
  cleanText,
  sanitizeAccount,
  sanitizeCookies,
  sanitizeExtensions,
  sanitizeProxyConfig,
  sanitizeStartUrls,
  sanitizeTags
} from './validation'

export { cohereFingerprint, hostOs, hostFingerprintEnvironment }
export { sanitizeStartUrls }

function requireHostOs(os: OsType): OsType {
  const host = hostOs()
  if (os !== host) {
    throw new Error(`Profile ${os} không được chạy trên host ${host}; cross-OS làm lộ vân tay thật.`)
  }
  return host
}

/**
 * OS to give a new profile by default = the HOST machine's OS. Matching the host is the
 * most undetectable choice: the profile's claimed GPU/Canvas can then match what the
 * engine ACTUALLY renders (Metal on Mac, D3D on Windows). A Windows profile on a Mac
 * spoofs the UA/UA-CH fine but its real WebGL/Canvas output is still Mac Metal — a deep
 * fingerprint mismatch enterprise anti-bot (wise.com's Cloudflare) catches. So a Mac
 * runs Mac profiles, a Windows box runs Windows profiles.
 */
export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dữ liệu profile không hợp lệ')
  const now = new Date().toISOString()
  const os = requireHostOs(input.os ?? hostOs())
  const profile: Profile = {
    id: randomUUID(),
    name: cleanText(input.name, 120).trim() || 'Profile mới',
    notes: cleanText(input.notes, 10_000),
    tags: sanitizeTags(input.tags),
    group: cleanText(input.group, 120).trim() || undefined,
    os,
    fingerprint: cohereFingerprint(input.fingerprint),
    proxy: sanitizeProxyConfig(input.proxy),
    startUrls: sanitizeStartUrls(input.startUrls),
    account: sanitizeAccount(input.account),
    createdAt: now,
    updatedAt: now
  }
  return saveProfile(profile)
}

export async function updateProfile(id: string, patch: Partial<Profile>): Promise<Profile> {
  // Never let a patch rewrite id/createdAt; apply atomically (read-modify-write inside
  // the store lock) so a concurrent edit to other fields isn't lost.
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Bản cập nhật profile không hợp lệ')
  const safe: Partial<Profile> = {}
  if ('name' in patch) {
    const name = cleanText(patch.name, 120).trim()
    if (name) safe.name = name
  }
  if ('notes' in patch) safe.notes = cleanText(patch.notes, 10_000)
  if ('tags' in patch) safe.tags = sanitizeTags(patch.tags)
  if ('group' in patch) safe.group = cleanText(patch.group, 120).trim() || undefined
  if ('os' in patch && patch.os) safe.os = requireHostOs(patch.os)
  if ('fingerprint' in patch) safe.fingerprint = cohereFingerprint(patch.fingerprint)
  if ('proxy' in patch) safe.proxy = sanitizeProxyConfig(patch.proxy)
  if ('startUrls' in patch) safe.startUrls = sanitizeStartUrls(patch.startUrls)
  if ('cookies' in patch) safe.cookies = sanitizeCookies(patch.cookies)
  if ('extensions' in patch) safe.extensions = sanitizeExtensions(patch.extensions)
  if ('account' in patch) safe.account = sanitizeAccount(patch.account)
  const updated = await patchProfile(id, { ...safe, updatedAt: new Date().toISOString() })
  if (!updated) throw new Error(`Không tìm thấy profile: ${id}`)
  return updated
}
