// ── VGC Browser — cloud profile DATA sync (GoLogin-style) ────────────────────
// The profiles_cloud table syncs profile *config* (fingerprint/proxy/cookies).
// This module syncs the actual browser *session* — the Chromium user-data-dir
// (cookies DB, Local Storage, IndexedDB, Login Data, Preferences…) — so a profile
// opened on ANY machine that logs into the account is already signed into every
// site, exactly like GoLogin.
//
// Flow:
//   • upload: zip the user-data-dir (minus volatile caches) → Supabase Storage
//             at  profiles/{uid}/{profileId}.zip  (private bucket, RLS per-owner).
//   • download: fetch that object → extract into the local user-data-dir.
// Auth: the renderer (supabase-js) owns the session; it hands us the access token
// via setCloudSession() so we can call the Storage REST API directly from main.

import { app } from 'electron'
import { promises as fs, existsSync, readdirSync, type Dirent } from 'fs'
import { join, relative, sep } from 'path'
import AdmZip from 'adm-zip'
import { getSettings } from './settings'
import { getProfile, saveProfile } from './store'
import { getCloudSession } from './session'
import {
  getAccountSecret,
  encryptWithSecret,
  decryptWithSecret,
  encryptBytes,
  decryptBytes,
  isEncryptedBytes,
  isEncryptionActive
} from './account-secret'
import { getProfileKey, ownerForProfile } from './profile-share'
import type { Cookie } from '../shared/types'

/** Encryption key for a profile's cloud data: a SHARED key if the profile is shared
 *  (so members decrypt it), otherwise this account's own secret. null = no key yet
 *  (pre-migration) → plaintext fallback. */
async function keyForProfile(id: string): Promise<string | null> {
  return (await getProfileKey(id)) ?? (await getAccountSecret())
}

const BUCKET = 'profiles'

// Folders inside the user-data-dir that are pure cache / volatile — excluded so
// the uploaded zip stays small (a few MB) and fast. Session-critical data
// (Cookies, Local/Session Storage, IndexedDB, Login Data, Web Data, Preferences,
// Network/…) is kept.
// Explicit non-"Cache" folders to drop (the generic *Cache* match below catches
// Cache/Code Cache/GPUCache/GraphiteDawnCache/ShaderCache/CacheStorage/etc.).
// These are big, machine-local, or re-derivable — never part of the login session.
const SKIP_DIRS = new Set<string>([
  'optimization_guide_model_store',
  'optimization_guide_prediction_model_downloads',
  'component_crx_cache',
  'extensions_crx_cache',
  'blob_storage',
  'Crashpad',
  'crash dumps',
  'BrowserMetrics',
  'Service Worker',
  'Safe Browsing',
  'segmentation_platform',
  'Subresource Filter',
  'SwReporter',
  'GraphiteDawnCache',
  // NOTE: 'Sessions' (Chromium's tab/session restore state) is NO LONGER skipped — it
  // must sync so NATIVE mode (no CDP injector) can reopen the user's tabs on another
  // machine via --restore-last-session. In CDP mode clearChromiumSession() deletes it
  // right after download and the injector reopens tabs from vgc-open-tabs.json, so
  // syncing it never causes double tabs. (See profile-manager.ts open flow.)
  // Big, non-login-session folders that bloat the zip past the 50MB cloud limit
  // (a profile's "Download Service" alone was seen at 44MB) → upload 413s and the
  // session never saves. None of these hold the login session.
  'Download Service',
  'Shared Dictionary',
  'shared_proto_db',
  'JumpListIconsMostVisited',
  'segmentation_platform',
  'optimization_guide_hint_cache_store',
  'AutofillStates',
  'PnaclTranslationCache',
  'VideoDecodeStats'
])

// Session-restore FILES are intentionally NOT skipped anymore (see the 'Sessions'
// note above): native mode needs them synced to reopen tabs cross-machine, and CDP
// mode deletes them post-download so there's no double-restore. Empty = skip nothing.
const SKIP_FILES = new Set<string>([])

function shouldSkipDir(name: string): boolean {
  // any cache-like folder + the explicit list above
  return name.includes('Cache') || SKIP_DIRS.has(name)
}

function profileDir(id: string): string {
  return join(app.getPath('userData'), 'profiles', id)
}

function storagePath(uid: string, id: string): string {
  return `${uid}/${id}.zip`
}

/** True once Chromium has populated the profile (so we have real session data). */
export function hasLocalData(id: string): boolean {
  const root = profileDir(id)
  return existsSync(join(root, 'Default')) || existsSync(join(root, 'Local State'))
}

function walk(zip: AdmZip, root: string, dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue
      walk(zip, root, full)
    } else if (e.isFile()) {
      // .pma = sparse memory-mapped metrics files (huge on disk, useless for the session)
      if (e.name.endsWith('.pma')) continue
      if (SKIP_FILES.has(e.name)) continue // tab/session restore → avoid double tabs
      const relDir = relative(root, dir).split(sep).join('/')
      try {
        zip.addLocalFile(full, relDir, e.name)
      } catch {
        // file locked/removed mid-zip — skip it
      }
    }
  }
}

function buildZip(id: string): AdmZip {
  const zip = new AdmZip()
  const root = profileDir(id)
  if (!existsSync(root)) return zip

  // ALLOWLIST approach: a Chromium user-data-dir root also holds big, auto-refetched
  // component/model downloads (TranslateKit, WasmTtsEngine, optimization_guide_*,
  // *Cache, etc.). The actual login session lives entirely under `Default/` plus the
  // root `Local State` file. So we sync ONLY those — robust against Chrome adding new
  // component folders, and keeps the zip tiny (a few MB).
  const localState = join(root, 'Local State')
  if (existsSync(localState)) {
    try {
      zip.addLocalFile(localState, '', 'Local State')
    } catch {
      // ignore
    }
  }
  const defaultDir = join(root, 'Default')
  if (existsSync(defaultDir)) walk(zip, root, defaultDir)
  return zip
}

/**
 * Guard against uploading a PARTIAL session that would overwrite good cloud data.
 * `walk()` skips files that are locked mid-zip; if Chromium still held the cookie
 * DB, the zip would be missing it → downloading it elsewhere looks "logged out".
 * Returns true if it's safe to upload: either the profile has no cookie DB on disk
 * yet (brand-new), or at least one cookie DB that DOES exist on disk made it into
 * the zip.
 */
function zipHasCriticalSession(zip: AdmZip, id: string): boolean {
  const root = profileDir(id)
  const cookieDbs = [
    join(root, 'Default', 'Network', 'Cookies'),
    join(root, 'Default', 'Cookies')
  ].filter((p) => existsSync(p))
  if (cookieDbs.length === 0) return true // nothing to protect yet
  const inZip = new Set(zip.getEntries().map((e) => e.entryName))
  return cookieDbs.some((p) => inZip.has(relative(root, p).split(sep).join('/')))
}

/** Zip the profile's user-data-dir and upload it to the user's cloud bucket. */
export async function uploadProfileData(id: string): Promise<void> {
  const session = getCloudSession()
  if (!session) throw new Error('Chưa đăng nhập cloud')
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) throw new Error('Chưa cấu hình Supabase')

  const zip = buildZip(id)
  // Don't overwrite a good cloud session with a partial one (locked cookie DB).
  if (!zipHasCriticalSession(zip, id)) {
    throw new Error(
      'Bỏ qua lưu phiên: cookie đang bị khoá (Chromium chưa nhả file). Giữ nguyên bản cloud cũ.'
    )
  }
  // Encrypt the WHOLE session zip with the per-account secret before upload, so the
  // cloud holds ciphertext — not just the os_crypt-protected Cookies/Login Data but
  // ALSO Local Storage / IndexedDB / Preferences (where sites often keep auth
  // tokens). Falls back to a raw zip only pre-migration (no secret yet); the reader
  // detects which it got.
  const rawZip = zip.toBuffer()
  const encSecret = await keyForProfile(id)
  // If encryption has worked before but the key is momentarily unavailable (network
  // blip fetching account_secrets), REFUSE to upload plaintext — that would overwrite
  // the encrypted cloud copy with a readable one. Keep the old encrypted blob instead.
  if (!encSecret && isEncryptionActive()) {
    throw new Error('Bỏ qua lưu phiên: chưa lấy được khoá mã hoá (mạng chập chờn). Giữ bản mã hoá cũ.')
  }
  const body = encSecret ? encryptBytes(encSecret, 'session', rawZip) : rawZip
  // Shared profiles live in the OWNER's folder; write there so the owner (and other
  // members) see the update. Own profiles resolve to our own uid.
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath(ownerUid, id)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      apikey: s.supabaseAnonKey,
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true'
    },
    // Buffer is a valid body for Node/undici fetch; the DOM BodyInit type is too narrow.
    body: body as unknown as BodyInit
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const mb = (body.length / 1048576).toFixed(1)
    if (res.status === 413 || detail.includes('too large')) {
      throw new Error(
        `Dữ liệu phiên quá lớn (${mb}MB) vượt giới hạn cloud (50MB). Thử xoá bớt cache trong profile.`
      )
    }
    throw new Error(`Upload dữ liệu lỗi HTTP ${res.status} (${mb}MB) ${detail}`)
  }
  // Mark that this profile now has cloud session data.
  const p = await getProfile(id)
  if (p) {
    p.cloudDataAt = new Date().toISOString()
    await saveProfile(p)
  }
}

/**
 * Download the profile's cloud data zip and extract it into the local
 * user-data-dir. Returns false if the cloud has no data for this profile yet.
 */
export async function downloadProfileData(id: string): Promise<boolean> {
  const session = getCloudSession()
  if (!session) throw new Error('Chưa đăng nhập cloud')
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) throw new Error('Chưa cấu hình Supabase')

  // Read from the owner's folder for shared profiles (see uploadProfileData).
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath(ownerUid, id)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) return false // not uploaded yet
  if (!res.ok) throw new Error(`Tải dữ liệu lỗi HTTP ${res.status}`)

  let buf: Buffer = Buffer.from(await res.arrayBuffer())
  // Decrypt if it's one of our encrypted session blobs (raw zips start with "PK").
  if (isEncryptedBytes(buf)) {
    const encSecret = await keyForProfile(id)
    const dec = encSecret ? decryptBytes(encSecret, 'session', buf) : null
    if (!dec) {
      // Encrypted but we can't decrypt (no secret / wrong account) → don't extract
      // garbage over the local session; leave it intact.
      throw new Error('Không giải mã được dữ liệu phiên (thiếu khoá tài khoản).')
    }
    buf = dec
  }
  const root = profileDir(id)
  await fs.mkdir(root, { recursive: true })
  const zip = new AdmZip(buf)
  zip.extractAllTo(root, /* overwrite */ true)
  return true
}

// ── Cross-machine COOKIES (plaintext, engine-agnostic) ───────────────────────
// Chrome encrypts the Cookies/Login Data DBs with a key bound to the machine
// (Keychain on macOS, DPAPI on Windows), so the encrypted files in the session
// zip don't decrypt on another machine → the user looks logged OUT. Cookies ARE
// the login session, so we sync them SEPARATELY as plaintext: read them decrypted
// over CDP on the source machine, store them as JSON, and re-inject them on the
// target machine (where Chrome re-encrypts with ITS own key). Works across macOS
// ⇄ Windows with no engine rebuild. (Saved-password autofill ENTRIES still need
// the portable-key engine patch on both platforms — that's separate.)

function cookiesObjectPath(uid: string, id: string): string {
  return `${uid}/${id}.cookies.json`
}

/** Upload the profile's decrypted cookies (captured via CDP) to the cloud. */
export async function uploadProfileCookies(id: string, cookies: Cookie[]): Promise<void> {
  if (!cookies.length) return
  const session = getCloudSession()
  if (!session) return
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesObjectPath(ownerUid, id)}`
  // Encrypt the cookies with the per-account secret before they leave the machine,
  // so a leaked bucket shows ciphertext, not live session tokens. Falls back to
  // plaintext only when the secret isn't available yet (pre-migration).
  const json = JSON.stringify(cookies)
  const secret = await keyForProfile(id)
  // Same guard as uploadProfileData: never downgrade to plaintext cookies once
  // encryption is known to work — a transient key-fetch failure would leak live tokens.
  if (!secret && isEncryptionActive()) {
    throw new Error('Bỏ qua lưu cookie: chưa lấy được khoá mã hoá (mạng chập chờn). Giữ bản mã hoá cũ.')
  }
  const body = secret
    ? Buffer.from(JSON.stringify({ enc: encryptWithSecret(secret, 'cookies', json) }), 'utf-8')
    : Buffer.from(json, 'utf-8')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      apikey: s.supabaseAnonKey,
      'Content-Type': 'application/json',
      'x-upsert': 'true'
    },
    body: body as unknown as BodyInit
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Upload cookie lỗi HTTP ${res.status} ${detail}`)
  }
}

/** Fetch the profile's cloud cookies (plaintext JSON). [] if none uploaded yet. */
export async function downloadProfileCookies(id: string): Promise<Cookie[]> {
  const session = getCloudSession()
  if (!session) return []
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return []
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesObjectPath(ownerUid, id)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) return []
  if (!res.ok) return []
  try {
    const data = (await res.json()) as Cookie[] | { enc?: string }
    if (Array.isArray(data)) return data // legacy plaintext
    if (data && typeof data.enc === 'string') {
      const secret = await keyForProfile(id)
      if (!secret) return []
      const json = decryptWithSecret(secret, 'cookies', data.enc)
      if (!json) return []
      const arr = JSON.parse(json) as Cookie[]
      return Array.isArray(arr) ? arr : []
    }
    return []
  } catch {
    return []
  }
}
