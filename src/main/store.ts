// ── VGC Browser — profile storage (encrypted at rest) ────────────────────────
// Profiles (cookies, proxy passwords, fingerprints) are sensitive, so the DB is
// encrypted on disk with Electron safeStorage (Windows DPAPI / macOS Keychain /
// libsecret). Falls back to plaintext JSON only if OS encryption is unavailable.
// Legacy profiles.json is auto-migrated to the encrypted store on first read.

import { app, safeStorage } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import type { Profile } from '../shared/types'
import { accountKey } from './session'

function dataDir(): string {
  return join(app.getPath('userData'), 'db')
}
// Profiles are scoped PER ACCOUNT (by Supabase uid) so logging in with a different
// email shows only that account's profiles — never another account's. 'local' is
// used when signed out (the app gates on login, so normally a uid is set).
function jsonFile(): string {
  return join(dataDir(), `profiles-${accountKey()}.json`)
}
function encFile(): string {
  return join(dataDir(), `profiles-${accountKey()}.enc`)
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export async function listProfiles(): Promise<Profile[]> {
  await fs.mkdir(dataDir(), { recursive: true })

  // Preferred: encrypted store.
  if (existsSync(encFile())) {
    try {
      const buf = await fs.readFile(encFile())
      const plain = canEncrypt() ? safeStorage.decryptString(buf) : buf.toString('utf-8')
      return JSON.parse(plain) as Profile[]
    } catch {
      // fall through to legacy / empty
    }
  }

  // Legacy plaintext → migrate to encrypted on next write.
  if (existsSync(jsonFile())) {
    try {
      const profiles = JSON.parse(await fs.readFile(jsonFile(), 'utf-8')) as Profile[]
      await writeAll(profiles)
      return profiles
    } catch {
      return []
    }
  }
  return []
}

async function writeAll(profiles: Profile[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  const plain = JSON.stringify(profiles, null, 2)
  if (canEncrypt()) {
    await fs.writeFile(encFile(), safeStorage.encryptString(plain))
    // Remove any leftover plaintext copy.
    try {
      if (existsSync(jsonFile())) await fs.unlink(jsonFile())
    } catch {
      // ignore
    }
  } else {
    await fs.writeFile(jsonFile(), plain, 'utf-8')
  }
}

export async function getProfile(id: string): Promise<Profile | null> {
  const all = await listProfiles()
  return all.find((p) => p.id === id) ?? null
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const all = await listProfiles()
  const idx = all.findIndex((p) => p.id === profile.id)
  if (idx >= 0) all[idx] = profile
  else all.push(profile)
  await writeAll(all)
  return profile
}

export async function deleteProfile(id: string): Promise<void> {
  const all = await listProfiles()
  await writeAll(all.filter((p) => p.id !== id))
}

/**
 * Remove many profiles at once by id. Used by the cloud pull to apply deletions
 * that happened on another machine (tombstoned rows), so a profile deleted on one
 * machine disappears here too instead of re-appearing on every "Làm mới".
 */
export async function removeMany(ids: string[]): Promise<void> {
  if (!ids.length) return
  const all = await listProfiles()
  const set = new Set(ids)
  const next = all.filter((p) => !set.has(p.id))
  if (next.length !== all.length) await writeAll(next)
}

/** Upsert many profiles at once (used by import + cloud pull). */
export async function saveMany(profiles: Profile[]): Promise<void> {
  const all = await listProfiles()
  const byId = new Map(all.map((p) => [p.id, p]))
  for (const p of profiles) byId.set(p.id, p)
  await writeAll([...byId.values()])
}
