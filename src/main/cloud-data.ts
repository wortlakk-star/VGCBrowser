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
// after online verification so main can call the Storage REST API directly.

import { app } from 'electron'
import {
  promises as fs,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
  type Dirent
} from 'fs'
import { join, relative, sep } from 'path'
import { randomUUID } from 'crypto'
import AdmZip from 'adm-zip'
import { getSettings } from './settings'
import { patchProfile } from './store'
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
import type { Cookie, SavedLogin, SavedCookie } from '../shared/types'
import { requireProfileId, requireUuid, sanitizeCookies } from './validation'

/** Encryption key for a profile's cloud data. Cross-account sharing is disabled until
 *  per-recipient key envelopes exist, so this currently resolves to the account key. */
async function keyForProfile(id: string): Promise<string | null> {
  return (await getProfileKey(id)) ?? (await getAccountSecret())
}

const BUCKET = 'profiles'
const MAX_CLOUD_OBJECT_BYTES = 64 * 1024 * 1024
const CLOUD_ENVELOPE_PREFIX = 'VGC2:'
const SESSION_BOUND_MAGIC = Buffer.from('VGCSESS2', 'ascii')
const SESSION_ENCRYPTION_OVERHEAD = SESSION_BOUND_MAGIC.length + 8 + 12 + 16
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 20_000
const MAX_EXTRACTED_ENTRIES = 30_000
const MAX_JSON_PLAINTEXT_BYTES = 16 * 1024 * 1024
const MAX_JSON_OBJECT_BYTES = 24 * 1024 * 1024
const MAX_SAVED_LOGINS = 10_000
const MAX_SAVED_COOKIES = 20_000
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function boundContext(kind: string, id: string): string {
  return `${kind}:${requireProfileId(id)}`
}

function encryptProfileJson(secret: string, kind: string, id: string, plaintext: string): string {
  return CLOUD_ENVELOPE_PREFIX + encryptWithSecret(secret, boundContext(kind, id), plaintext)
}

function decryptProfileJson(
  secret: string,
  kind: string,
  id: string,
  blob: string
): { plaintext: string; legacy: boolean } | null {
  const legacy = !blob.startsWith(CLOUD_ENVELOPE_PREFIX)
  const ciphertext = legacy ? blob : blob.slice(CLOUD_ENVELOPE_PREFIX.length)
  const plaintext = decryptWithSecret(
    secret,
    legacy ? kind : boundContext(kind, id),
    ciphertext
  )
  return plaintext ? { plaintext, legacy } : null
}

function encryptSession(secret: string, id: string, zip: Buffer): Buffer {
  return Buffer.concat([
    SESSION_BOUND_MAGIC,
    encryptBytes(secret, boundContext('session', id), zip)
  ])
}

function isBoundSession(buf: Buffer): boolean {
  return (
    buf.length >= SESSION_BOUND_MAGIC.length &&
    buf.subarray(0, SESSION_BOUND_MAGIC.length).equals(SESSION_BOUND_MAGIC)
  )
}

function cloudFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(120_000)
  })
}

async function responseBuffer(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('Dữ liệu cloud vượt giới hạn an toàn.')
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('Dữ liệu cloud vượt giới hạn an toàn.')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total)
}

async function responseJson<T>(res: Response): Promise<T> {
  return JSON.parse((await responseBuffer(res, MAX_JSON_OBJECT_BYTES)).toString('utf-8')) as T
}

async function responseText(res: Response, maxBytes = 64 * 1024): Promise<string> {
  return (await responseBuffer(res, maxBytes)).toString('utf8')
}

function validateSessionZip(zip: AdmZip): void {
  const entries = zip.getEntries()
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('Dữ liệu phiên có quá nhiều file.')
  const files = new Set<string>()
  const directories = new Set<string>()
  let total = 0
  for (const entry of entries) {
    const rawName = entry.entryName
    const name = rawName.replace(/\\/g, '/').replace(entry.isDirectory ? /\/$/ : /$^/, '')
    const parts = name.split('/')
    const size = Number(entry.header.size) || 0
    const unixMode = (Number(entry.header.attr) >>> 16) & 0o170000
    if (
      rawName.includes('\\') ||
      (name !== 'Default' && !name.startsWith('Default/')) ||
      name.startsWith('/') ||
      /^[a-z]:/i.test(name) ||
      parts.length > 32 ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          Buffer.byteLength(part, 'utf8') > 255 ||
          /[\0-\x1f<>:"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          WINDOWS_RESERVED_NAME.test(part)
      ) ||
      Buffer.byteLength(name, 'utf8') > 1024 ||
      name.includes('\0') ||
      entry.header.encrypted ||
      ![0, 8].includes(Number(entry.header.method)) ||
      (unixMode !== 0 && unixMode !== 0o040000 && unixMode !== 0o100000) ||
      (entry.isDirectory && unixMode === 0o100000) ||
      (!entry.isDirectory && unixMode === 0o040000)
    ) {
      throw new Error('Dữ liệu phiên chứa đường dẫn hoặc liên kết không an toàn.')
    }
    const canonicalParts = parts.map((part) => part.normalize('NFC').toLowerCase())
    const canonical = canonicalParts.join('/')
    for (let i = 1; i < canonicalParts.length; i++) {
      const parent = canonicalParts.slice(0, i).join('/')
      if (files.has(parent)) throw new Error('Dữ liệu phiên chứa đường dẫn xung đột.')
      directories.add(parent)
    }
    if (entry.isDirectory) {
      if (files.has(canonical)) throw new Error('Dữ liệu phiên chứa đường dẫn xung đột.')
      directories.add(canonical)
    } else {
      if (files.has(canonical) || directories.has(canonical)) {
        throw new Error('Dữ liệu phiên chứa tên file trùng hoặc xung đột.')
      }
      files.add(canonical)
    }
    if (files.size + directories.size > MAX_EXTRACTED_ENTRIES) {
      throw new Error('Dữ liệu phiên tạo ra quá nhiều đường dẫn.')
    }
    if (entry.isDirectory && size !== 0) {
      throw new Error('Thư mục trong dữ liệu phiên có kích thước không hợp lệ.')
    }
    if (size > MAX_ZIP_ENTRY_BYTES) throw new Error('Một file trong dữ liệu phiên quá lớn.')
    total += size
    if (total > MAX_UNPACKED_BYTES) throw new Error('Dữ liệu phiên giải nén vượt giới hạn an toàn.')
  }
}

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
// The os_crypt-encrypted stores (Cookies, Login Data) are sealed with a PER-MACHINE key
// the other machine can't read — syncing them just churns the key and logs the user out.
// Keep them PURELY LOCAL (each machine keeps its own stable session); Local State (the key
// itself) was already dropped from buildZip. This is the reliable baseline; cross-machine
// cookie/password transfer is handled separately.
const SKIP_FILES = new Set<string>([
  'Cookies',
  'Cookies-journal',
  'Cookies-wal',
  'Cookies-shm',
  'Login Data',
  'Login Data-journal',
  'Login Data-wal',
  'Login Data-shm',
  'Login Data For Account-journal',
  'Login Data For Account-wal',
  'Login Data For Account-shm',
  'Login Data For Account'
])

function shouldSkipDir(name: string): boolean {
  // any cache-like folder + the explicit list above
  return name.includes('Cache') || SKIP_DIRS.has(name)
}

function profileDir(id: string): string {
  return join(app.getPath('userData'), 'profiles', requireProfileId(id))
}

function storagePath(uid: string, id: string): string {
  return `${requireUuid(uid, 'Owner ID')}/${requireProfileId(id)}.zip`
}

// ── Freshness marker ─────────────────────────────────────────────────────────
// Records the cloud object's ETag the last time we successfully synced this profile
// (upload OR download). Stored OUTSIDE the profile dir so it is never itself zipped/
// synced. On open we compare the cloud's current ETag against this: if unchanged, the
// cloud has nothing newer than what we already have — so we must NOT extract it over a
// possibly-newer local session (e.g. our last close-upload failed or the app was
// force-quit). ETag is server-side, so it is immune to cross-machine clock skew.
function syncTagPath(uid: string, id: string): string {
  return join(
    app.getPath('userData'),
    'sync-meta',
    requireUuid(uid, 'Account ID'),
    `${requireProfileId(id)}.tag`
  )
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await fs.mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Thư mục đồng bộ không an toàn.')
  }
  await fs.chmod(path, 0o700).catch(() => {})
}

async function readSyncTag(uid: string, id: string): Promise<string> {
  let handle: fs.FileHandle | undefined
  try {
    const path = syncTagPath(uid, id)
    handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) {
      return ''
    }
    return (await handle.readFile({ encoding: 'utf8' })).trim().slice(0, 512)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeSyncTag(uid: string, id: string, tag: string): Promise<void> {
  const safeTag = tag.replace(/[^a-z0-9._:+\/-]/gi, '').slice(0, 512)
  if (!safeTag) return
  const root = join(app.getPath('userData'), 'sync-meta')
  const accountRoot = join(root, requireUuid(uid, 'Account ID'))
  const path = syncTagPath(uid, id)
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await ensurePrivateDirectory(root)
    await ensurePrivateDirectory(accountRoot)
    try {
      const current = await fs.lstat(path)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    await fs.writeFile(temp, safeTag, { mode: 0o600, flag: 'wx' })
    await fs.rename(temp, path)
  } catch {
    // Best effort. A missing tag causes a safe re-download on the next open.
  } finally {
    await fs.unlink(temp).catch(() => {})
  }
}

/** Current ETag plus enough prefix bytes to distinguish encrypted objects from legacy
 * raw ZIPs. A tiny Range GET avoids downloading the whole session just for freshness. */
async function getCloudObjectInfo(
  objUrl: string,
  token: string,
  anon: string
): Promise<{ etag: string; encrypted: boolean; bound: boolean }> {
  try {
    const r = await cloudFetch(objUrl, {
      headers: { Authorization: `Bearer ${token}`, apikey: anon, Range: 'bytes=0-7' }
    })
    if (!r.ok && r.status !== 206) {
      await r.body?.cancel().catch(() => {})
      return { etag: '', encrypted: false, bound: false }
    }
    const prefix = await responseBuffer(r, 8)
    const bound = isBoundSession(prefix)
    return {
      etag: (r.headers.get('etag') || '').replace(/"/g, ''),
      encrypted: bound || isEncryptedBytes(prefix),
      bound
    }
  } catch {
    return { etag: '', encrypted: false, bound: false }
  }
}

async function getCloudEtag(objUrl: string, token: string, anon: string): Promise<string> {
  return (await getCloudObjectInfo(objUrl, token, anon)).etag
}

/** True once Chromium has populated the profile (so we have real session data). */
export function hasLocalData(id: string): boolean {
  const root = profileDir(id)
  return existsSync(join(root, 'Default')) || existsSync(join(root, 'Local State'))
}

interface ZipBudget {
  entries: number
  bytes: number
}

function walk(zip: AdmZip, root: string, dir: string, budget: ZipBudget): void {
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
      walk(zip, root, full, budget)
    } else if (e.isFile()) {
      // .pma = sparse memory-mapped metrics files (huge on disk, useless for the session)
      if (e.name.endsWith('.pma')) continue
      if (SKIP_FILES.has(e.name)) continue
      const relDir = relative(root, dir).split(sep).join('/')
      let fd: number | null = null
      try {
        const before = lstatSync(full)
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) continue
        fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.nlink !== 1) continue
        const size = opened.size
        if (size > MAX_ZIP_ENTRY_BYTES) throw new Error('Một file phiên vượt giới hạn an toàn.')
        const data = readFileSync(fd)
        if (data.length > MAX_ZIP_ENTRY_BYTES) {
          throw new Error('Một file phiên vượt giới hạn an toàn.')
        }
        budget.entries++
        budget.bytes += data.length
        if (budget.entries > MAX_ZIP_ENTRIES || budget.bytes > MAX_UNPACKED_BYTES) {
          throw new Error('Dữ liệu phiên vượt giới hạn đóng gói an toàn.')
        }
        zip.addFile(`${relDir}/${e.name}`, data)
      } catch (error) {
        if (error instanceof Error && error.message.includes('vượt giới hạn')) throw error
        // A file locked or removed during snapshotting is best-effort session data.
      } finally {
        if (fd !== null) closeSync(fd)
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
  // *Cache, etc.). The actual login session lives entirely under `Default/`.
  //
  // We deliberately DO NOT sync the root `Local State` file: it holds this machine's
  // os_crypt `encrypted_key` (DPAPI-wrapped on Windows, Keychain on macOS) which is
  // MACHINE-SPECIFIC. Syncing it made another machine's key overwrite the local one →
  // the engine couldn't decrypt its own Cookies/Login Data → logged out on every reopen.
  // Each machine keeps its own stable Local State. The credential bridge decrypts on
  // the source and re-encrypts with the target machine's key.
  const defaultDir = join(root, 'Default')
  if (existsSync(defaultDir)) walk(zip, root, defaultDir, { entries: 0, bytes: 0 })
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
  // Cookies + Login Data are now DELIBERATELY excluded from the zip and kept purely
  // local (see SKIP_FILES + buildZip). The old guard required a Cookies DB to be
  // present in the zip; with cookies excluded that would reject EVERY upload and throw
  // on every close — silently killing sync of tabs / Local Storage / IndexedDB /
  // Preferences (the only things the zip still carries). We still require at least one
  // real file whenever local data exists, otherwise a failed/empty snapshot could erase
  // a healthy cloud session. Cookies and saved logins travel separately, encrypted in
  // cloud and re-keyed by password-bridge.ts on the target machine.
  if (!hasLocalData(id)) return false
  return zip
    .getEntries()
    .some((entry) => !entry.isDirectory && Number(entry.header.size) > 0)
}

async function validateRegularTree(
  root: string,
  options: { enforceBudget: boolean; normalizeModes: boolean }
): Promise<void> {
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Cây dữ liệu phiên không an toàn.')
  }
  const stack = [root]
  let entries = 0
  let bytes = 0
  while (stack.length) {
    const dir = stack.pop()!
    const children = await fs.readdir(dir, { withFileTypes: true })
    for (const child of children) {
      const full = join(dir, child.name)
      const stat = await fs.lstat(full)
      entries++
      if (options.enforceBudget && entries > MAX_EXTRACTED_ENTRIES) {
        throw new Error('Dữ liệu phiên giải nén tạo ra quá nhiều file.')
      }
      if (stat.isSymbolicLink()) throw new Error('Dữ liệu phiên chứa liên kết không an toàn.')
      if (stat.isDirectory()) {
        if (options.normalizeModes) await fs.chmod(full, 0o700).catch(() => {})
        stack.push(full)
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error('Dữ liệu phiên chứa file đặc biệt hoặc hardlink không an toàn.')
      }
      if (options.enforceBudget) {
        if (stat.size > MAX_ZIP_ENTRY_BYTES) throw new Error('File giải nén vượt giới hạn an toàn.')
        bytes += stat.size
        if (bytes > MAX_UNPACKED_BYTES) {
          throw new Error('Dữ liệu phiên giải nén vượt giới hạn an toàn.')
        }
      }
      if (options.normalizeModes) await fs.chmod(full, 0o600).catch(() => {})
    }
  }
}

export async function ensureSafeProfileDestination(id: string): Promise<string> {
  const profilesRoot = join(app.getPath('userData'), 'profiles')
  await ensurePrivateDirectory(profilesRoot)
  const root = profileDir(id)
  await ensurePrivateDirectory(root)
  const defaultDir = join(root, 'Default')
  try {
    await validateRegularTree(defaultDir, { enforceBudget: false, normalizeModes: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await ensurePrivateDirectory(defaultDir)
  }
  return root
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
      'Bỏ qua lưu phiên: snapshot local đang trống hoặc chưa hoàn chỉnh. Giữ nguyên bản cloud cũ.'
    )
  }
  // Encrypt the WHOLE session zip with the per-account secret before upload, so the
  // cloud holds ciphertext — not just the os_crypt-protected Cookies/Login Data but
  // ALSO Local Storage / IndexedDB / Preferences (where sites often keep auth
  // tokens). Missing key material is a hard failure; no plaintext session is uploaded.
  const rawZip = zip.toBuffer()
  if (rawZip.length > MAX_CLOUD_OBJECT_BYTES - SESSION_ENCRYPTION_OVERHEAD) {
    throw new Error('Dữ liệu phiên vượt giới hạn 64 MB trước khi mã hoá.')
  }
  const encSecret = await keyForProfile(id)
  if (!encSecret) {
    throw new Error('Bỏ qua lưu phiên: chưa có khoá mã hoá đầu-cuối. Không tải dữ liệu plaintext lên cloud.')
  }
  const body = encryptSession(encSecret, id, rawZip)
  if (body.length > MAX_CLOUD_OBJECT_BYTES) throw new Error('Dữ liệu phiên mã hoá vượt giới hạn 64 MB.')
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath(ownerUid, id)}`
  const res = await cloudFetch(url, {
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
    const detail = await responseText(res).catch(() => '')
    const mb = (body.length / 1048576).toFixed(1)
    if (res.status === 413 || detail.includes('too large')) {
      throw new Error(
        `Dữ liệu phiên quá lớn (${mb}MB) vượt giới hạn cloud (64MB). Thử xoá bớt cache trong profile.`
      )
    }
    throw new Error(`Upload dữ liệu lỗi HTTP ${res.status} (${mb}MB) ${detail}`)
  }
  // Record the new cloud ETag as our synced version, so the next open recognises this
  // upload as "already have it" (skips a redundant download) and, crucially, so a later
  // failed upload leaves the marker on the LAST-GOOD version (freshness guard above).
  const newTag = (res.headers.get('etag') || '').replace(/"/g, '')
  await res.body?.cancel().catch(() => {})
  if (newTag) {
    await writeSyncTag(session.uid, id, newTag)
  } else {
    const tag = await getCloudEtag(url, session.accessToken, s.supabaseAnonKey)
    if (tag) await writeSyncTag(session.uid, id, tag)
  }

  // Mark that this profile now has cloud session data (atomic patch — never write back
  // a whole stale profile snapshot, which could clobber a concurrent edit).
  await patchProfile(id, { cloudDataAt: new Date().toISOString() })
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

  // Freshness guard: only overwrite the local session if the cloud copy actually
  // CHANGED since our last successful sync. If the ETag matches what we last synced,
  // the cloud has nothing newer — extracting it would clobber a possibly-NEWER local
  // session (our last close-upload failed / app force-quit) and destroy new logins +
  // tabs. Skip and keep local (it re-uploads on the next close).
  const cloudInfo = await getCloudObjectInfo(url, session.accessToken, s.supabaseAnonKey)
  const cloudTag = cloudInfo.etag
  if (cloudInfo.bound && cloudTag && (await readSyncTag(session.uid, id)) === cloudTag) {
    return false
  }

  const res = await cloudFetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) {
    await res.body?.cancel().catch(() => {})
    return false // not uploaded yet
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Tải dữ liệu lỗi HTTP ${res.status}`)
  }

  let buf = await responseBuffer(res, MAX_CLOUD_OBJECT_BYTES)
  let migratedTag = ''
  const encSecret = await keyForProfile(id)
  // Legacy raw ZIPs and unbound VGCENC1 objects are accepted only for an owner-side
  // one-time migration. VGCSESS2 binds authentication to this exact profile ID, so a
  // storage-side object swap cannot transplant one browser session into another.
  let needsMigration = false
  if (isBoundSession(buf)) {
    const inner = buf.subarray(SESSION_BOUND_MAGIC.length)
    const dec = encSecret ? decryptBytes(encSecret, boundContext('session', id), inner) : null
    if (!dec) {
      throw new Error('Không giải mã được dữ liệu phiên (thiếu khoá tài khoản).')
    }
    buf = dec
  } else if (isEncryptedBytes(buf)) {
    const dec = encSecret ? decryptBytes(encSecret, 'session', buf) : null
    if (!dec) throw new Error('Không giải mã được dữ liệu phiên cũ.')
    buf = dec
    needsMigration = true
  } else {
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || !encSecret) {
      throw new Error('Dữ liệu phiên cloud không có định dạng mã hoá hợp lệ.')
    }
    needsMigration = true
  }
  if (needsMigration) {
    const encrypted = encryptSession(encSecret!, id, buf)
    if (encrypted.length > MAX_CLOUD_OBJECT_BYTES) {
      throw new Error('Không thể di chuyển dữ liệu phiên cũ vì vượt giới hạn 64 MB.')
    }
    const migrate = await cloudFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        apikey: s.supabaseAnonKey,
        'Content-Type': 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: encrypted as unknown as BodyInit
    })
    if (!migrate.ok) {
      await migrate.body?.cancel().catch(() => {})
      throw new Error(`Không thể mã hoá dữ liệu phiên cloud cũ (HTTP ${migrate.status}).`)
    }
    migratedTag = (migrate.headers.get('etag') || '').replace(/"/g, '')
    await migrate.body?.cancel().catch(() => {})
    if (!migratedTag) {
      migratedTag = await getCloudEtag(url, session.accessToken, s.supabaseAnonKey)
    }
  }
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('Dữ liệu phiên giải mã không phải ZIP hợp lệ.')
  }
  const zip = new AdmZip(buf)
  validateSessionZip(zip)
  const root = await ensureSafeProfileDestination(id)
  // Make the synced tab/session state AUTHORITATIVE. adm-zip only overwrites same-named
  // files, so extracting the other machine's Sessions/ would leave THIS machine's older
  // timestamped Session_<ts> files behind → --restore-last-session might reopen this
  // machine's stale tabs instead of the ones synced from the other machine. If the
  // incoming zip carries Sessions, wipe the local Sessions/ + Session Storage first so
  // extraction fully REPLACES them.
  const carriesSessions = zip
    .getEntries()
    .some((e) => e.entryName.replace(/\\/g, '/').startsWith('Default/Sessions/'))
  // Never let a synced (foreign-machine) zip overwrite THIS machine's own os_crypt-bound
  // session files — `Local State` (the machine's os_crypt key), the Cookies DB, and Login
  // Data. Overwriting them with another machine's copy (sealed with a DIFFERENT key) makes
  // the engine unable to decrypt them → logged out on every reopen. Each machine keeps its
  // own. The credential bridge transfers decrypted records separately and re-encrypts
  // them with this machine's os_crypt key.
  const preserveBases = ['Local State', 'Default/Network/Cookies', 'Default/Cookies', 'Default/Login Data'].filter(
    (b) => {
      try {
        const lp = join(root, ...b.split('/'))
        const stat = lstatSync(lp)
        return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0
      } catch {
        return false
      }
    }
  )
  if (preserveBases.length) {
    for (const e of zip.getEntries()) {
      const rel = e.entryName.replace(/\\/g, '/')
      if (preserveBases.some((b) => rel === b || rel.startsWith(b + '-') || rel.startsWith(b + ' '))) {
        try {
          zip.deleteFile(e.entryName)
        } catch {
          /* ignore */
        }
      }
    }
  }
  // Extract into a private staging directory first. Only a validated `Default/`
  // tree is copied into the profile, so malformed archives never write directly
  // into a live Chromium user-data directory.
  const stagingRoot = join(app.getPath('userData'), 'sync-staging')
  await ensurePrivateDirectory(stagingRoot)
  const staging = join(stagingRoot, `${id}-${randomUUID()}`)
  await fs.mkdir(staging, { mode: 0o700 })
  try {
    zip.extractAllTo(staging, /* overwrite */ false)
    await validateRegularTree(staging, { enforceBudget: true, normalizeModes: true })
    const stagedTop = await fs.readdir(staging)
    if (stagedTop.length !== 1 || stagedTop[0] !== 'Default') {
      throw new Error('Dữ liệu phiên không có thư mục Default hợp lệ.')
    }
    const stagedDefault = join(staging, 'Default')
    if (existsSync(stagedDefault)) {
      await validateRegularTree(join(root, 'Default'), {
        enforceBudget: false,
        normalizeModes: false
      })
      if (carriesSessions) {
        await fs.rm(join(root, 'Default', 'Sessions'), { recursive: true, force: true }).catch(() => {})
        await fs
          .rm(join(root, 'Default', 'Session Storage'), { recursive: true, force: true })
          .catch(() => {})
      }
      await fs.mkdir(join(root, 'Default'), { recursive: true, mode: 0o700 })
      await fs.cp(stagedDefault, join(root, 'Default'), {
        recursive: true,
        force: true,
        errorOnExist: false,
        dereference: false,
        verbatimSymlinks: true
      })
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
  // Remember the cloud version we now hold so the next open can tell if cloud changed.
  const newTag = (migratedTag || res.headers.get('etag') || cloudTag || '').replace(/"/g, '')
  if (newTag) await writeSyncTag(session.uid, id, newTag)
  return true
}

// ── Cross-machine COOKIES (encrypted transport, engine-agnostic) ─────────────
// Chrome encrypts the Cookies/Login Data DBs with a key bound to the machine
// (Keychain on macOS, DPAPI on Windows), so the encrypted files in the session
// zip don't decrypt on another machine → the user looks logged OUT. Cookies ARE
// the login session, so we sync them separately: read them decrypted over CDP on the
// source machine, encrypt the JSON with the account key, and re-inject them on the
// target machine (where Chrome re-encrypts with ITS own key). Works across macOS
// ⇄ Windows with no engine rebuild. (Saved-password autofill ENTRIES still need
// the portable-key engine patch on both platforms — that's separate.)

function cookiesObjectPath(uid: string, id: string): string {
  return `${requireUuid(uid, 'Owner ID')}/${requireProfileId(id)}.cookies.json`
}

/** Upload the profile's decrypted cookies (captured via CDP) to the cloud. */
export async function uploadProfileCookies(id: string, cookies: Cookie[]): Promise<void> {
  const safeCookies = sanitizeCookies(cookies)
  if (!safeCookies.length) return
  const session = getCloudSession()
  if (!session) return
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesObjectPath(ownerUid, id)}`
  // Encrypt the cookies before they leave the machine so a leaked bucket contains no
  // reusable session tokens.
  const json = JSON.stringify(safeCookies)
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_PLAINTEXT_BYTES) {
    throw new Error('Dữ liệu cookie vượt giới hạn 16 MB.')
  }
  const secret = await keyForProfile(id)
  if (!secret) throw new Error('Bỏ qua lưu cookie: chưa có khoá mã hoá đầu-cuối.')
  const body = Buffer.from(
    JSON.stringify({ enc: encryptProfileJson(secret, 'cookies', id, json) }),
    'utf-8'
  )
  const res = await cloudFetch(url, {
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
    const detail = await responseText(res).catch(() => '')
    throw new Error(`Upload cookie lỗi HTTP ${res.status} ${detail}`)
  }
  await res.body?.cancel().catch(() => {})
}

/** Fetch the profile's cloud cookies (plaintext JSON). [] if none uploaded yet. */
export async function downloadProfileCookies(id: string): Promise<Cookie[]> {
  const session = getCloudSession()
  if (!session) return []
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return []
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesObjectPath(ownerUid, id)}`
  const res = await cloudFetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) {
    await res.body?.cancel().catch(() => {})
    return []
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return []
  }
  try {
    const data = await responseJson<Cookie[] | { enc?: string }>(res)
    if (Array.isArray(data)) {
      const legacy = sanitizeCookies(data)
      if (legacy.length) await uploadProfileCookies(id, legacy).catch(() => {})
      return legacy
    }
    if (data && typeof data.enc === 'string') {
      const secret = await keyForProfile(id)
      if (!secret) return []
      const decoded = decryptProfileJson(secret, 'cookies', id, data.enc)
      if (!decoded) return []
      const cookies = sanitizeCookies(JSON.parse(decoded.plaintext))
      if (decoded.legacy && cookies.length) await uploadProfileCookies(id, cookies).catch(() => {})
      return cookies
    }
    return []
  } catch {
    return []
  }
}

// ── Cross-machine SAVED PASSWORDS (plaintext, engine-agnostic) ────────────────
// Same idea as the cookie bridge: saved logins are decrypted with the SOURCE machine's
// os_crypt key, stored account-secret-encrypted here, and re-encrypted with the TARGET
// machine's key on open (see password-bridge.ts). This makes autofill passwords survive
// Windows DPAPI key ⇄ macOS Chromium Safe Storage key.

function passwordsObjectPath(uid: string, id: string): string {
  return `${requireUuid(uid, 'Owner ID')}/${requireProfileId(id)}.passwords.json`
}

/** Upload the profile's DECRYPTED saved logins (account-secret-encrypted) to the cloud. */
export async function uploadProfilePasswords(id: string, logins: SavedLogin[]): Promise<void> {
  if (!logins.length) return
  const session = getCloudSession()
  if (!session) return
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${passwordsObjectPath(ownerUid, id)}`
  const json = JSON.stringify(logins.slice(0, MAX_SAVED_LOGINS))
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_PLAINTEXT_BYTES) {
    throw new Error('Dữ liệu mật khẩu vượt giới hạn 16 MB.')
  }
  const secret = await keyForProfile(id)
  // Never write plaintext passwords once encryption is known to work (transient key
  // failure would leak credentials) — keep the last encrypted copy instead.
  if (!secret && isEncryptionActive()) {
    throw new Error('Bỏ qua lưu mật khẩu: chưa lấy được khoá mã hoá (mạng chập chờn).')
  }
  if (!secret) return // pre-migration: refuse to upload plaintext passwords at all
  const body = Buffer.from(
    JSON.stringify({ enc: encryptProfileJson(secret, 'passwords', id, json) }),
    'utf-8'
  )
  const res = await cloudFetch(url, {
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
    const detail = await responseText(res).catch(() => '')
    throw new Error(`Upload mật khẩu lỗi HTTP ${res.status} ${detail}`)
  }
  await res.body?.cancel().catch(() => {})
}

/** Fetch + decrypt the profile's cloud saved logins. [] if none / not decryptable. */
export async function downloadProfilePasswords(id: string): Promise<SavedLogin[]> {
  const session = getCloudSession()
  if (!session) return []
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return []
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${passwordsObjectPath(ownerUid, id)}`
  const res = await cloudFetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) {
    await res.body?.cancel().catch(() => {})
    return []
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return []
  }
  try {
    const data = await responseJson<{ enc?: string }>(res)
    if (!data || typeof data.enc !== 'string') return []
    const secret = await keyForProfile(id)
    if (!secret) return []
    const decoded = decryptProfileJson(secret, 'passwords', id, data.enc)
    if (!decoded) return []
    const arr = JSON.parse(decoded.plaintext) as SavedLogin[]
    const logins = Array.isArray(arr) ? arr.slice(0, MAX_SAVED_LOGINS) : []
    if (decoded.legacy && logins.length) await uploadProfilePasswords(id, logins).catch(() => {})
    return logins
  } catch {
    return []
  }
}

// ── Cross-machine SAVED COOKIES-DB (session, engine-agnostic) ─────────────────
// The native-mode engine attaches no CDP, so the old cookie bridge (CDP getCookies)
// can't run → login sessions were only in the encrypted zip, which doesn't decrypt on a
// different-key machine. This syncs the cookies read straight from the SQLite DB
// (decrypted with the source machine's key, re-encrypted on the target — see
// password-bridge.ts), account-secret-encrypted here. Separate object from the legacy
// `.cookies.json` (CDP) bridge so the two never collide.

function cookiesDbObjectPath(uid: string, id: string): string {
  return `${requireUuid(uid, 'Owner ID')}/${requireProfileId(id)}.cookiesdb.json`
}

/** Upload the profile's DECRYPTED cookies (account-secret-encrypted) to the cloud. */
export async function uploadProfileCookiesDb(id: string, cookies: SavedCookie[]): Promise<void> {
  if (!cookies.length) return
  const session = getCloudSession()
  if (!session) return
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesDbObjectPath(ownerUid, id)}`
  const json = JSON.stringify(cookies.slice(0, MAX_SAVED_COOKIES))
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_PLAINTEXT_BYTES) {
    throw new Error('Dữ liệu cookie DB vượt giới hạn 16 MB.')
  }
  const secret = await keyForProfile(id)
  if (!secret && isEncryptionActive()) {
    throw new Error('Bỏ qua lưu cookie: chưa lấy được khoá mã hoá (mạng chập chờn).')
  }
  if (!secret) return // never upload plaintext session cookies
  const body = Buffer.from(
    JSON.stringify({ enc: encryptProfileJson(secret, 'cookiesdb', id, json) }),
    'utf-8'
  )
  const res = await cloudFetch(url, {
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
    const detail = await responseText(res).catch(() => '')
    throw new Error(`Upload cookie-db lỗi HTTP ${res.status} ${detail}`)
  }
  await res.body?.cancel().catch(() => {})
}

/** Fetch + decrypt the profile's cloud cookies. [] if none / not decryptable. */
export async function downloadProfileCookiesDb(id: string): Promise<SavedCookie[]> {
  const session = getCloudSession()
  if (!session) return []
  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return []
  const ownerUid = (await ownerForProfile(id)) ?? session.uid
  const url = `${s.supabaseUrl}/storage/v1/object/${BUCKET}/${cookiesDbObjectPath(ownerUid, id)}`
  const res = await cloudFetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: s.supabaseAnonKey }
  })
  if (res.status === 404 || res.status === 400) {
    await res.body?.cancel().catch(() => {})
    return []
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return []
  }
  try {
    const data = await responseJson<{ enc?: string }>(res)
    if (!data || typeof data.enc !== 'string') return []
    const secret = await keyForProfile(id)
    if (!secret) return []
    const decoded = decryptProfileJson(secret, 'cookiesdb', id, data.enc)
    if (!decoded) return []
    const arr = JSON.parse(decoded.plaintext) as SavedCookie[]
    const cookies = Array.isArray(arr) ? arr.slice(0, MAX_SAVED_COOKIES) : []
    if (decoded.legacy && cookies.length) await uploadProfileCookiesDb(id, cookies).catch(() => {})
    return cookies
  } catch {
    return []
  }
}
