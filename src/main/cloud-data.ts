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
import type { Cookie } from '../shared/types'

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
  'GraphiteDawnCache'
])

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
  const body = zip.toBuffer()
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath(session.uid, id)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      apikey: s.supabaseAnonKey,
      'Content-Type': 'application/zip',
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

  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath(session.uid, id)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) return false // not uploaded yet
  if (!res.ok) throw new Error(`Tải dữ liệu lỗi HTTP ${res.status}`)

  const buf = Buffer.from(await res.arrayBuffer())
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
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesObjectPath(session.uid, id)}`
  const body = Buffer.from(JSON.stringify(cookies), 'utf-8')
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
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesObjectPath(session.uid, id)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) return []
  if (!res.ok) return []
  try {
    const data = (await res.json()) as Cookie[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
