// ── VGC Browser — profile storage (encrypted at rest) ────────────────────────
// Profiles (cookies, proxy passwords, fingerprints) are sensitive, so the DB is
// encrypted on disk with Electron safeStorage (Windows DPAPI / macOS Keychain /
// libsecret). Falls back to plaintext JSON only if OS encryption is unavailable.
// Legacy profiles.json is auto-migrated to the encrypted store on first read.

import { app, safeStorage } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import type { Profile, Fingerprint } from '../shared/types'
import { generateFingerprint } from '../shared/fingerprint'
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

/**
 * Self-heal a profile with missing/partial required fields. A malformed profile
 * (created via the API, synced from an older schema, or hand-edited) would crash the
 * WHOLE renderer — ProfileTable reads p.fingerprint.userAgent, p.proxy.type, etc., so
 * ONE bad profile blanks the entire app, and the profile can't be launched. Reinstall
 * never fixes it because the bad data lives in the (synced) store, not the app files.
 * We fill every required field with a sensible default ONCE; the caller persists it so
 * it's stable (re-generating the fingerprint each load would change it every launch —
 * bad for antidetect). Returns true if anything was repaired.
 */
function normalizeProfiles(profiles: Profile[]): boolean {
  let changed = false
  const now = new Date().toISOString()
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue
    if (!p.id) { p.id = randomUUID(); changed = true }
    if (typeof p.name !== 'string') { p.name = 'Profile'; changed = true }
    if (typeof p.notes !== 'string') { p.notes = ''; changed = true }
    if (!Array.isArray(p.tags)) { p.tags = []; changed = true }
    if (p.os !== 'windows' && p.os !== 'macos' && p.os !== 'linux' && p.os !== 'android') {
      p.os = 'windows'; changed = true
    }
    const fp = p.fingerprint as Fingerprint | undefined
    if (!fp || !fp.userAgent || !fp.webgl || !fp.screen) {
      p.fingerprint = generateFingerprint(p.os); changed = true
    }
    if (!p.proxy || typeof p.proxy.type !== 'string') {
      p.proxy = { type: 'none' }; changed = true
    }
    if (!Array.isArray(p.startUrls)) { p.startUrls = []; changed = true }
    if (typeof p.createdAt !== 'string') { p.createdAt = now; changed = true }
    if (typeof p.updatedAt !== 'string') { p.updatedAt = now; changed = true }
  }
  return changed
}

export async function listProfiles(): Promise<Profile[]> {
  await fs.mkdir(dataDir(), { recursive: true })

  let profiles: Profile[] | null = null

  // Preferred: encrypted store.
  if (existsSync(encFile())) {
    try {
      const buf = await fs.readFile(encFile())
      const plain = canEncrypt() ? safeStorage.decryptString(buf) : buf.toString('utf-8')
      profiles = JSON.parse(plain) as Profile[]
    } catch {
      profiles = null // fall through to legacy / empty
    }
  }

  // Legacy plaintext → migrate to encrypted on next write.
  if (!profiles && existsSync(jsonFile())) {
    try {
      profiles = JSON.parse(await fs.readFile(jsonFile(), 'utf-8')) as Profile[]
      await writeAll(profiles)
    } catch {
      profiles = null
    }
  }

  if (!profiles) return []

  // Repair any profile with missing/partial required fields (else the UI blanks) and
  // persist the repair so it's stable. Best-effort: a write failure still returns the
  // healed in-memory list so the UI renders this session.
  if (normalizeProfiles(profiles)) {
    try {
      await writeAll(profiles)
    } catch {
      // best-effort — return the healed list regardless
    }
  }
  return profiles
}

// Serialize every read-modify-write so concurrent mutations (launch bumping
// lastUsedAt, an auto-pull saveMany, a proxy-check updateProfile, a cloudDataAt
// write) can't interleave and lose each other's changes. Each serialized fn runs
// listProfiles()→mutate→writeAll() atomically vs other mutations.
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(
    () => {},
    () => {}
  )
  return run
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
  return serialize(async () => {
    const all = await listProfiles()
    const idx = all.findIndex((p) => p.id === profile.id)
    if (idx >= 0) all[idx] = profile
    else all.push(profile)
    await writeAll(all)
    return profile
  })
}

/**
 * Atomically read-modify-write ONE profile: re-reads the current record INSIDE the
 * serialize lock and applies only `patch`, so a slow caller holding a stale snapshot
 * (e.g. launchProfile bumping lastUsedAt after a multi-second cloud download, or a
 * proxy-check writing proxyCheck) can't clobber a concurrent edit to OTHER fields.
 * Prefer this over getProfile()+saveProfile() for partial updates. Returns null if
 * the profile no longer exists.
 */
export async function patchProfile(id: string, patch: Partial<Profile>): Promise<Profile | null> {
  return serialize(async () => {
    const all = await listProfiles()
    const idx = all.findIndex((p) => p.id === id)
    if (idx < 0) return null
    const updated: Profile = { ...all[idx], ...patch, id: all[idx].id }
    all[idx] = updated
    await writeAll(all)
    return updated
  })
}

export async function deleteProfile(id: string): Promise<void> {
  return serialize(async () => {
    const all = await listProfiles()
    await writeAll(all.filter((p) => p.id !== id))
  })
}

/**
 * Remove many profiles at once by id. Used by the cloud pull to apply deletions
 * that happened on another machine (tombstoned rows), so a profile deleted on one
 * machine disappears here too instead of re-appearing on every "Làm mới".
 */
export async function removeMany(ids: string[]): Promise<void> {
  if (!ids.length) return
  return serialize(async () => {
    const all = await listProfiles()
    const set = new Set(ids)
    const next = all.filter((p) => !set.has(p.id))
    if (next.length !== all.length) await writeAll(next)
  })
}

/**
 * Upsert many profiles at once (used by import + cloud pull). On pull, an incoming
 * copy only OVERWRITES a local one when it is newer (by updatedAt) — so an auto-pull
 * can't clobber a local edit that hasn't been pushed yet (e.g. a push that failed
 * transiently). New ids are always added. ISO timestamps compare lexicographically.
 */
export async function saveMany(profiles: Profile[]): Promise<void> {
  return serialize(async () => {
    const all = await listProfiles()
    const byId = new Map(all.map((p) => [p.id, p]))
    for (const p of profiles) {
      const existing = byId.get(p.id)
      if (!existing || !existing.updatedAt || (p.updatedAt ?? '') >= existing.updatedAt) {
        byId.set(p.id, p)
      }
    }
    await writeAll([...byId.values()])
  })
}
