// ── VGC Browser — profile storage (encrypted at rest) ────────────────────────
// Profiles (cookies, proxy passwords, fingerprints) are sensitive, so the DB is
// encrypted on disk with Electron safeStorage (Windows DPAPI / macOS Keychain /
// libsecret). The store fails closed if OS encryption is unavailable. Legacy
// profiles.json is auto-migrated to the encrypted store on first read.

import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import type { Profile, Fingerprint } from '../shared/types'
import { CHROME_BUILD } from '../shared/fingerprint'
import { accountKey } from './session'
import { cohereFingerprint, hostOs } from './host-fingerprint'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'
import {
  cleanText,
  isUuid,
  sanitizeAccount,
  sanitizeCookies,
  sanitizeExtensions,
  sanitizeProxyConfig,
  sanitizeStartUrls,
  sanitizeTags
} from './validation'

function dataDir(): string {
  return join(app.getPath('userData'), 'db')
}
// Profiles are scoped PER ACCOUNT (by Supabase uid) so logging in with a different
// email shows only that account's profiles — never another account's. 'local' is
// used when signed out (the app gates on login, so normally a uid is set).
interface StorePaths {
  encrypted: string
  legacy: string
}

function storePaths(key = accountKey()): StorePaths {
  return {
    encrypted: join(dataDir(), `profiles-${key}.enc`),
    legacy: join(dataDir(), `profiles-${key}.json`)
  }
}

function normalizedIso(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return fallback
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time < Date.UTC(2000, 0, 1) || time > Date.now() + 5 * 60_000) {
    return fallback
  }
  return new Date(time).toISOString()
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
  const ids = new Set<string>()
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue
    if (!isUuid(p.id) || ids.has(p.id)) { p.id = randomUUID(); changed = true }
    ids.add(p.id)
    const name = cleanText(p.name, 120).trim() || 'Profile'
    if (p.name !== name) { p.name = name; changed = true }
    const notes = cleanText(p.notes, 10_000)
    if (p.notes !== notes) { p.notes = notes; changed = true }
    const tags = sanitizeTags(p.tags)
    if (JSON.stringify(p.tags) !== JSON.stringify(tags)) { p.tags = tags; changed = true }
    const group = cleanText(p.group, 120).trim() || undefined
    if (p.group !== group) { p.group = group; changed = true }
    const host = hostOs()
    if (p.os !== host) { p.os = host; changed = true }
    const fp = p.fingerprint as Fingerprint | undefined
    if (!fp || !fp.userAgent || !fp.webgl || !fp.screen) {
      p.fingerprint = cohereFingerprint(); changed = true
    } else {
      const coherent = cohereFingerprint(fp)
      if (JSON.stringify(coherent) !== JSON.stringify(fp)) {
        p.fingerprint = coherent
        changed = true
      }
    }
    // Keep the claimed Chrome version aligned with the VGC Core engine. A profile that
    // still claims Chrome 149 while the engine's UA-CH advertises 151 is a version
    // MISMATCH — anti-bot (Google "browser not secure", Cloudflare) rejects it. Bump the
    // version only; the DEVICE fingerprint (canvas/webgl/hw) is untouched, so it's just
    // like Chrome auto-updating and the login session is preserved.
    const cfp = p.fingerprint as Fingerprint
    if (cfp?.userAgent) {
      const cm = cfp.userAgent.match(/Chrome\/(\d+)/)
      if (cm && cm[1] !== String(CHROME_BUILD.major)) {
        cfp.userAgent = cfp.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${CHROME_BUILD.major}.0.0.0`)
        cfp.uaFullVersion = CHROME_BUILD.full
        changed = true
      } else if (cfp.uaFullVersion && cfp.uaFullVersion.split('.')[0] !== cm?.[1]) {
        // The UA major already matched, so the branch above never fired — but an
        // IMPORTED profile can carry a uaFullVersion from a different major (the engine
        // derives the whole Sec-CH-UA brand list from this field, so UA would say 151
        // while Sec-CH-UA said 126). Re-align it on its own.
        cfp.uaFullVersion = CHROME_BUILD.full
        changed = true
      }
    }
    // navigator.deviceMemory is quantised by Chrome to 0.25/0.5/1/2/4/8 and capped at 8.
    // Older builds let the UI store 16, which no real Chrome can ever report.
    if (cfp && typeof cfp.deviceMemory === 'number' && ![0.25, 0.5, 1, 2, 4, 8].includes(cfp.deviceMemory)) {
      cfp.deviceMemory = cfp.deviceMemory > 8 ? 8 : 4
      changed = true
    }
    const proxy = sanitizeProxyConfig(p.proxy)
    if (JSON.stringify(p.proxy) !== JSON.stringify(proxy)) { p.proxy = proxy; changed = true }
    const startUrls = sanitizeStartUrls(p.startUrls)
    if (JSON.stringify(p.startUrls) !== JSON.stringify(startUrls)) { p.startUrls = startUrls; changed = true }
    const account = sanitizeAccount(p.account)
    if (JSON.stringify(p.account) !== JSON.stringify(account)) { p.account = account; changed = true }
    const cookies = sanitizeCookies(p.cookies)
    if (p.cookies && JSON.stringify(p.cookies) !== JSON.stringify(cookies)) { p.cookies = cookies; changed = true }
    const extensions = sanitizeExtensions(p.extensions)
    if (p.extensions && JSON.stringify(p.extensions) !== JSON.stringify(extensions)) { p.extensions = extensions; changed = true }
    if (p.cloudTeamId !== undefined) { p.cloudTeamId = undefined; changed = true }
    const cloudDataAt = normalizedIso(p.cloudDataAt)
    if (p.cloudDataAt !== cloudDataAt) { p.cloudDataAt = cloudDataAt; changed = true }
    if (p.proxyCheck) {
      const status = p.proxyCheck.status === 'ok' || p.proxyCheck.status === 'error' ? p.proxyCheck.status : 'error'
      const at = normalizedIso(p.proxyCheck.at, now)!
      const latency = Number(p.proxyCheck.latencyMs)
      const proxyCheck: NonNullable<Profile['proxyCheck']> = {
        status,
        at,
        ...(typeof p.proxyCheck.ip === 'string' ? { ip: cleanText(p.proxyCheck.ip, 64) } : {}),
        ...(typeof p.proxyCheck.country === 'string'
          ? { country: cleanText(p.proxyCheck.country, 120) }
          : {}),
        ...(typeof p.proxyCheck.countryCode === 'string'
          ? { countryCode: cleanText(p.proxyCheck.countryCode, 2).toUpperCase() }
          : {}),
        ...(Number.isFinite(latency)
          ? { latencyMs: Math.max(0, Math.min(300_000, latency)) }
          : {})
      }
      if (JSON.stringify(p.proxyCheck) !== JSON.stringify(proxyCheck)) { p.proxyCheck = proxyCheck; changed = true }
    }
    const createdAt = normalizedIso(p.createdAt, now)!
    if (p.createdAt !== createdAt) { p.createdAt = createdAt; changed = true }
    const updatedAt = normalizedIso(p.updatedAt, now)!
    if (p.updatedAt !== updatedAt) { p.updatedAt = updatedAt; changed = true }
    const lastUsedAt = normalizedIso(p.lastUsedAt)
    if (p.lastUsedAt !== lastUsedAt) { p.lastUsedAt = lastUsedAt; changed = true }
  }
  return changed
}

async function listProfilesAt(paths: StorePaths): Promise<Profile[]> {
  const loaded =
    (await readSecureJson<Profile[]>(paths.encrypted)) ??
    (await migratePlainJson<Profile[]>(paths.encrypted, paths.legacy))

  if (!loaded) return []
  if (!Array.isArray(loaded)) throw new Error('Kho profile không đúng định dạng')
  const profiles = loaded
    .filter((p): p is Profile => !!p && typeof p === 'object' && !Array.isArray(p))
    .slice(0, 10_000)
  const filteredInvalidRows = profiles.length !== loaded.length

  // Repair any profile with missing/partial required fields (else the UI blanks) and
  // persist the repair so it's stable. Best-effort: a write failure still returns the
  // healed in-memory list so the UI renders this session.
  if (filteredInvalidRows || normalizeProfiles(profiles)) {
    try {
      await writeAllAt(paths, profiles)
    } catch {
      // best-effort — return the healed list regardless
    }
  }
  return profiles
}

export function listProfiles(): Promise<Profile[]> {
  const paths = storePaths()
  return serialize(paths, () => listProfilesAt(paths))
}

// Serialize every read-modify-write so concurrent mutations (launch bumping
// lastUsedAt, an auto-pull saveMany, a proxy-check updateProfile, a cloudDataAt
// write) can't interleave and lose each other's changes. Each serialized fn runs
// listProfiles()→mutate→writeAll() atomically vs other mutations.
const writeChains = new Map<string, Promise<unknown>>()
function serialize<T>(paths: StorePaths, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(paths.encrypted) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => {},
    () => {}
  )
  writeChains.set(paths.encrypted, settled)
  void settled.finally(() => {
    if (writeChains.get(paths.encrypted) === settled) writeChains.delete(paths.encrypted)
  })
  return run
}

async function writeAllAt(paths: StorePaths, profiles: Profile[]): Promise<void> {
  await writeSecureJson(paths.encrypted, profiles)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const paths = storePaths()
  return serialize(paths, async () => {
    const all = await listProfilesAt(paths)
    return all.find((p) => p.id === id) ?? null
  })
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const paths = storePaths()
  return serialize(paths, async () => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('Profile không hợp lệ')
    }
    normalizeProfiles([profile])
    const all = await listProfilesAt(paths)
    const idx = all.findIndex((p) => p.id === profile.id)
    if (idx >= 0) all[idx] = profile
    else all.push(profile)
    await writeAllAt(paths, all)
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
  const paths = storePaths()
  return serialize(paths, async () => {
    const all = await listProfilesAt(paths)
    const idx = all.findIndex((p) => p.id === id)
    if (idx < 0) return null
    const updated: Profile = { ...all[idx], ...patch, id: all[idx].id }
    normalizeProfiles([updated])
    all[idx] = updated
    await writeAllAt(paths, all)
    return updated
  })
}

export async function deleteProfile(id: string): Promise<void> {
  const paths = storePaths()
  return serialize(paths, async () => {
    const all = await listProfilesAt(paths)
    await writeAllAt(paths, all.filter((p) => p.id !== id))
  })
}

/**
 * Remove many profiles at once by id. Used by the cloud pull to apply deletions
 * that happened on another machine (tombstoned rows), so a profile deleted on one
 * machine disappears here too instead of re-appearing on every "Làm mới".
 */
export async function removeMany(ids: string[]): Promise<void> {
  if (!ids.length) return
  const paths = storePaths()
  return serialize(paths, async () => {
    const all = await listProfilesAt(paths)
    const set = new Set(ids)
    const next = all.filter((p) => !set.has(p.id))
    if (next.length !== all.length) await writeAllAt(paths, next)
  })
}

/**
 * Upsert many profiles at once (used by import + cloud pull). On pull, an incoming
 * copy only OVERWRITES a local one when it is newer (by updatedAt) — so an auto-pull
 * can't clobber a local edit that hasn't been pushed yet (e.g. a push that failed
 * transiently). New ids are always added. ISO timestamps compare lexicographically.
 */
export async function saveMany(profiles: Profile[]): Promise<void> {
  const paths = storePaths()
  return serialize(paths, async () => {
    const safe = Array.isArray(profiles)
      ? profiles.filter((p): p is Profile => !!p && typeof p === 'object' && !Array.isArray(p)).slice(0, 10_000)
      : []
    normalizeProfiles(safe)
    const all = await listProfilesAt(paths)
    const byId = new Map(all.map((p) => [p.id, p]))
    for (const p of safe) {
      const existing = byId.get(p.id)
      if (!existing || !existing.updatedAt || (p.updatedAt ?? '') >= existing.updatedAt) {
        byId.set(p.id, p)
      }
    }
    await writeAllAt(paths, [...byId.values()].slice(0, 10_000))
  })
}
