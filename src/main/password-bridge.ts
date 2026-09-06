// ── VGC Browser — cross-machine SAVED PASSWORDS bridge ───────────────────────
// Chromium stores saved website logins in the `Default/Login Data` SQLite DB with each
// password ENCRYPTED by the machine's os_crypt key. That key differs per engine:
//   • Windows VGC Core uses the profile's DPAPI-wrapped AES-256-GCM machine key.
//   • macOS VGC Core uses the Chromium Safe Storage keychain password, deriving an
//     AES-128-CBC key with PBKDF2-SHA1.
// So a Login Data written on one machine is undecryptable on the other, and syncing the
// zip just overwrites one machine's logins with the other's (last-writer-wins → both
// vanish). Cookies already dodge this via a plaintext bridge; passwords didn't — this
// module is the symmetric fix.
//
// export: read `logins`, DECRYPT each password with the LOCAL key → SavedLogin[].
// import: MERGE SavedLogin[] into the local `logins`, RE-ENCRYPTING with the LOCAL key,
//         so the local engine can read them. INSERT-or-update only, never deletes.
//
// SAFETY: everything is wrapped so a failure can only make the bridge a NO-OP (never a
// crash, never data loss). We use sql.js (pure-WASM SQLite — no native build, works
// identically on Windows + macOS): the DB is loaded from bytes into memory, mutated,
// integrity-checked in memory, then written back ATOMICALLY (temp file + rename), so the
// live Login Data is never left half-written. A broken sql.js load just disables it.

import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { dbg } from './dbg'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join, dirname } from 'path'
import type { SavedLogin, SavedCookie } from '../shared/types'

// sql.js is loaded lazily so a missing/broken WASM just disables the bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SQL: any = null
let sqlTried = false
async function getSQL(): Promise<unknown> {
  if (SQL) return SQL
  if (sqlTried) return null
  sqlTried = true
  try {
    // Runtime CJS require (sql.js is externalised by electron-vite). Resolve the WASM
    // next to the module's dist entry and hand its bytes to initSqlJs so no on-disk
    // path lookup (which fails inside app.asar) is needed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wasmPath = join(dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
    const wasmBinary = readFileSync(wasmPath)
    SQL = await initSqlJs({ wasmBinary })
    return SQL
  } catch (e) {
    console.error('[vgc-pw] sql.js unavailable — password bridge disabled:', e)
    return null
  }
}

const V10 = Buffer.from('v10', 'latin1')
const FIXED_IV = Buffer.alloc(16, 0x20) // 16 spaces — the os_crypt v10 AES-128-CBC IV
const MAX_LOGIN_DB_BYTES = 128 * 1024 * 1024
const MAX_COOKIE_DB_BYTES = 128 * 1024 * 1024
const MAX_LOCAL_STATE_BYTES = 4 * 1024 * 1024
const MAX_LOGIN_ROWS = 10_000
const MAX_COOKIE_ROWS = 20_000
const MAX_SECRET_CHARS = 64 * 1024
const SAFE_COLUMN_RE = /^[a-z_][a-z0-9_]{0,63}$/i

// macOS keychain-derived key, cached once SUCCESSFULLY resolved (a failed read is retried on
// the next call — a denied/slow prompt must not disable the bridge for the whole app session).
// Machine-wide: VGC Core uses one key for all profiles.
let macKeyCache: Buffer | undefined
let macKeyInFlight: Promise<Buffer | null> | null = null

/** Clock-skew tolerance for cross-machine "newer wins" comparisons (Chrome epoch µs): a local
 *  row only beats the incoming (cloud) copy when it is newer by MORE than this, so two
 *  machines whose clocks differ by a minute or two do not keep each other's stale cookie. */
const SKEW_TOLERANCE_US = 120 * 1_000_000

function loginDataPath(userDataDir: string): string {
  return join(userDataDir, 'Default', 'Login Data')
}

function execFileText(
  file: string,
  args: string[],
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout ?? '').trim())
    })
  })
}

/**
 * The LOCAL machine's os_crypt AES-128 key for a profile, or null if it can't be
 * derived (→ bridge skips, safely). Mirrors exactly what the running engine uses so
 * blobs we write are readable by it and blobs it wrote are readable by us. Async so a
 * keychain prompt never blocks the main process; concurrent callers share one lookup.
 */
async function localKey(): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null // Linux: bridge off for now.
  if (macKeyCache) return macKeyCache
  if (macKeyInFlight) return macKeyInFlight
  macKeyInFlight = (async () => {
    try {
      // The dedicated engine is Chromium-branded, so it uses these exact Keychain names.
      // Never fall back to Google Chrome's item: a valid but wrong key would make imported
      // credentials unreadable. The first read may show a macOS permission prompt.
      const pw = await execFileText(
        'security',
        ['find-generic-password', '-w', '-s', 'Chromium Safe Storage', '-a', 'Chromium'],
        90_000
      ).catch((e) => {
        dbg(`[vgc-pw] macOS keychain read failed: ${e instanceof Error ? e.message : String(e)}`)
        return ''
      })
      if (!pw) {
        console.error('[vgc-pw] macOS keychain key unavailable — grant "Always Allow" once')
        return null
      }
      macKeyCache = pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1')
      return macKeyCache
    } catch {
      return null
    } finally {
      macKeyInFlight = null
    }
  })()
  return macKeyInFlight
}

function decryptV10Bytes(blob: Buffer, key: Buffer): Buffer | null {
  try {
    if (blob.length <= 3 || !blob.subarray(0, 3).equals(V10)) return null
    const d = createDecipheriv('aes-128-cbc', key, FIXED_IV) // PKCS7 auto-unpad
    return Buffer.concat([d.update(blob.subarray(3)), d.final()])
  } catch {
    return null // wrong key / not our format → skip this row
  }
}

function decryptV10(blob: Buffer, key: Buffer): string | null {
  const b = decryptV10Bytes(blob, key)
  return b === null ? null : b.toString('utf8')
}

function encryptV10(plain: string, key: Buffer): Buffer {
  return encryptV10Bytes(Buffer.from(plain, 'utf8'), key)
}

function encryptV10Bytes(plain: Buffer, key: Buffer): Buffer {
  const c = createCipheriv('aes-128-cbc', key, FIXED_IV)
  return Buffer.concat([V10, c.update(plain), c.final()])
}

// AES-256-GCM v10 encrypt (the Windows machine-key format). "v10" + nonce[12] + ct + tag[16].
function encryptV10Gcm(plain: string, key: Buffer): Buffer {
  return encryptV10GcmBytes(Buffer.from(plain, 'utf8'), key)
}

function encryptV10GcmBytes(plain: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([V10, nonce, ct, c.getAuthTag()])
}

// ── The key the ENGINE actually uses (Option B: machine key, engine-agnostic) ─
// The VGC Core engine does NOT apply the portable --vgc-crypt-secret key (verified: it
// keeps writing the per-machine DPAPI key). So the bridge decrypts/encrypts with the SAME
// per-machine key the engine uses — Windows: DPAPI AES-256-GCM (from Local State); macOS:
// Chromium Safe Storage keychain AES-128-CBC. That makes each machine keep
// its own stable session AND lets the bridge translate cookies/passwords across machines
// (decrypt local → plaintext cloud → re-encrypt with the TARGET machine's key), no engine
// rebuild needed.
type EngKey = { key: Buffer; gcm: boolean }
async function engineKey(userDataDir: string): Promise<EngKey | null> {
  if (process.platform === 'win32') {
    const k = await windowsMachineKey(userDataDir)
    return k ? { key: k, gcm: true } : null
  }
  if (process.platform === 'darwin') {
    const k = await localKey() // macOS localKey = the keychain (machine) key, AES-128-CBC
    return k ? { key: k, gcm: false } : null
  }
  return null
}
function decryptEngine(blob: Buffer, ek: EngKey): Buffer | null {
  return ek.gcm ? decryptV10Gcm(blob, ek.key) : decryptV10Bytes(blob, ek.key)
}
function encryptEngine(plain: string, ek: EngKey): Buffer {
  return ek.gcm ? encryptV10Gcm(plain, ek.key) : encryptV10(plain, ek.key)
}

function encryptEngineBytes(plain: Buffer, ek: EngKey): Buffer {
  return ek.gcm ? encryptV10GcmBytes(plain, ek.key) : encryptV10Bytes(plain, ek.key)
}

/**
 * Forget any cached engine key (including a cached "unavailable" = null) for this profile
 * dir. Call right after the engine has just CREATED its key — the first-open bootstrap in
 * profile-manager.ts writes `Local State` (Windows) / the Safe Storage keychain item (macOS)
 * — so the next engineKey() re-reads it instead of returning the stale null it cached when
 * the key did not exist yet.
 */
export function resetEngineKeyCache(userDataDir: string): void {
  winMachineKeyCache.delete(userDataDir)
  macKeyCache = undefined
}

/**
 * True when this profile dir already has the STORES the credential bridge merges into: the
 * Cookies DB and the Login Data DB (both created by the engine on its first run — sql.js never
 * invents the engine's schema/version) and, on Windows, the `Local State` that carries this
 * machine's os_crypt key. On a machine that has never run this profile it is false, and
 * importCookies/importLogins would be silent no-ops → the caller bootstraps the stores first
 * (bootstrapProfileStores in profile-manager.ts). Deliberately does NOT depend on the key being
 * READABLE right now (see engineKeyReadable): a transient DPAPI/keychain failure must never make
 * the caller bootstrap — i.e. run a throwaway engine — over a profile that already has data.
 */
export function credentialStoresReady(userDataDir: string): boolean {
  if (!existsSync(cookiesDbPath(userDataDir)) || !existsSync(loginDataPath(userDataDir))) {
    return false
  }
  if (process.platform === 'win32' && !existsSync(join(userDataDir, 'Local State'))) return false
  return true
}

/** Can the bridge decrypt/encrypt with this machine's engine key right now? */
export async function engineKeyReadable(userDataDir: string): Promise<boolean> {
  return (await engineKey(userDataDir)) !== null
}

/** Why a side is not ready — a typed code, not free text, so callers can branch on it (and build
 *  their own message) instead of string-matching. */
export type CredentialUnreadyReason = 'wal-pending' | 'key-unavailable'

export const CREDENTIAL_UNREADY_TEXT: Record<CredentialUnreadyReason, string> = {
  'wal-pending': 'WAL/journal chưa flush (engine bị đóng cưỡng bức)',
  'key-unavailable': 'không đọc được khoá mã hoá máy (Keychain/DPAPI) lúc này'
}

/**
 * Can `exportCookies`/`exportLogins` actually read a TRUSTWORTHY snapshot right now — as
 * opposed to a bare `[]` they'd also return if the DB's WAL/journal is still pending (engine
 * still writing, or was just force-killed after ignoring a graceful close) or the machine key
 * is temporarily unreadable? Those two functions return `[]` for BOTH "genuinely zero rows"
 * and "could not read" — indistinguishable to a caller, which historically made a close-time
 * upload silently union in an EMPTY set as if it were confirmed-empty, report success, and
 * never actually save the session's new logins/cookies (this was the #1 cause of "some
 * profiles never keep their login" — the profile just always takes long enough to close that
 * it gets force-killed with its WAL still open). Call this BEFORE exportCookies/exportLogins
 * at close time; when a flag here is false, treat that side as UNKNOWN (skip uploading it,
 * same as a failed cloud download) rather than as "confirmed empty".
 */
export async function credentialExportReady(userDataDir: string): Promise<{
  cookies: boolean
  logins: boolean
  cookiesReason?: CredentialUnreadyReason
  loginsReason?: CredentialUnreadyReason
}> {
  const ck = cookiesDbPath(userDataDir)
  const ld = loginDataPath(userDataDir)
  const cookiesExists = existsSync(ck)
  const loginsExists = existsSync(ld)
  const cookiesPending = cookiesExists && hasPendingSqliteWrites(ck)
  const loginsPending = loginsExists && hasPendingSqliteWrites(ld)
  // The machine's os_crypt key can also be transiently unreadable (Keychain busy right after
  // wake, a DPAPI hiccup) — exportCookies/exportLogins silently return [] in that case too (via
  // their own internal engineKey() check), the exact "empty vs unreadable" ambiguity this
  // function exists to resolve. Only probe the key when there's something to decrypt — a
  // brand-new profile with no DB yet has nothing to read regardless of key state, so skip a
  // possibly-slow Keychain/DPAPI round-trip for a case that's already correctly "nothing to export".
  const keyOk = cookiesExists || loginsExists ? await engineKeyReadable(userDataDir) : true
  return {
    // A DB that doesn't exist yet is genuinely "nothing to export" (a brand-new profile), not
    // "unreadable" — only a PENDING WAL/journal on an EXISTING DB, or an unreadable key, is untrustworthy.
    cookies: !cookiesPending && keyOk,
    logins: !loginsPending && keyOk,
    cookiesReason: cookiesPending ? 'wal-pending' : !keyOk ? 'key-unavailable' : undefined,
    loginsReason: loginsPending ? 'wal-pending' : !keyOk ? 'key-unavailable' : undefined
  }
}

// ── Offline login check (no browser launch) ──────────────────────────────────
// "Is this profile already signed into Google?" without opening the engine — so a bulk job
// (or a user just wanting to know) never pays the cost of a full launch, and for a cross-machine
// profile never triggers the exclusive-lock hand-off/kick just to find out. GAIA (Google account)
// login is carried by a small, well-known cluster of cookies on the .google.com domain; SID is
// the primary session cookie, the __Secure-* variants are its HTTPS-only counterparts on modern
// Chrome. Any ONE present and unexpired is enough to call the account signed in.
export const GOOGLE_LOGIN_COOKIE_NAMES = ['SID', '__Secure-1PSID', '__Secure-3PSID']

/** Which of `rows` are a valid (unexpired, non-empty) Google/GAIA login cookie. Works on rows
 *  from ANY source — a local disk export or the decrypted cloud cookie object — since both are
 *  the same SavedCookie shape, so a caller can check a profile that only ever ran on another
 *  machine by matching the CLOUD row set instead of a local export. */
export function matchGoogleLoginCookies(rows: SavedCookie[]): SavedCookie[] {
  const nowUs = chromeNowUs()
  return rows.filter((c) => {
    const host = String(c.cols.host_key ?? '')
    const name = String(c.cols.name ?? '')
    return (
      (host === '.google.com' || host === 'google.com') &&
      GOOGLE_LOGIN_COOKIE_NAMES.includes(name) &&
      !cookieExpired(c, nowUs) &&
      c.value.length > 0
    )
  })
}

/** Offline Google-login check for a profile's LOCAL Cookies DB — reads straight off disk, same
 *  mechanism as the cross-machine credential bridge, no CDP, no engine process. Only reliable
 *  while the profile is CLOSED: while it's running the DB has a live WAL this can't see through
 *  (`reason: 'db-locked'`). A profile never opened on THIS machine has no local Cookies DB yet
 *  (`reason: 'no-cookies-db'`) — the caller should fall back to the cloud cookie object
 *  (downloadProfileCookiesDb + matchGoogleLoginCookies) for an answer in that case. */
export async function checkGoogleLoginOffline(userDataDir: string): Promise<{
  matched: SavedCookie[]
  reason: 'ok' | 'no-cookies-db' | 'db-locked' | 'engine-key-unavailable' | 'error'
}> {
  if (!existsSync(cookiesDbPath(userDataDir))) return { matched: [], reason: 'no-cookies-db' }
  const ready = await credentialExportReady(userDataDir)
  if (!ready.cookies) {
    return { matched: [], reason: ready.cookiesReason === 'key-unavailable' ? 'engine-key-unavailable' : 'db-locked' }
  }
  try {
    const rows = await exportCookies(userDataDir, 'login-check')
    return { matched: matchGoogleLoginCookies(rows), reason: 'ok' }
  } catch {
    return { matched: [], reason: 'error' }
  }
}

// ── Cross-machine MERGE helpers (used by the close-time upload) ──────────────
// The cloud credential objects are whole-set replacements, so a close must upload the UNION of
// what this machine has and what the cloud already holds — never just the local set. Otherwise
// one open whose import silently failed (hot journal, key hiccup, first-open bootstrap failure)
// would replace the cloud set with a partial one and deplete every other machine.

/** The cookie unique index (matches Chromium's `cookies` UNIQUE constraint). */
export function cookieKey(c: SavedCookie): string {
  const k = c.cols
  return [
    k.host_key ?? '',
    k.top_frame_site_key ?? '',
    Number(k.has_cross_site_ancestor ?? 0),
    k.name ?? '',
    k.path ?? '/',
    Number(k.source_scheme ?? 0),
    Number(k.source_port ?? 0)
  ].join('\u0000')
}

/** The login unique key (matches Chromium's `logins` UNIQUE index). */
export function loginKey(l: SavedLogin): string {
  return [
    l.origin_url,
    l.username_element ?? '',
    l.username_value ?? '',
    l.password_element ?? '',
    l.signon_realm
  ].join('\u0000')
}

/** Chrome epoch (µs since 1601) of `now`. */
function chromeNowUs(): number {
  return Math.round((Date.now() / 1000 + 11_644_473_600) * 1_000_000)
}

function cookieExpired(c: SavedCookie, nowUs: number): boolean {
  const exp = Number(c.cols.expires_utc ?? 0)
  const hasExpires = Number(c.cols.has_expires ?? (exp > 0 ? 1 : 0))
  return hasExpires === 1 && exp > 0 && exp < nowUs
}

/**
 * Union of two cookie sets by unique key. On a collision the copy with the newer
 * `last_update_utc` wins; `preferOverride` breaks near-ties (within the clock-skew tolerance)
 * in favour of `override` — the close path passes the LIVE machine's export as override so its
 * current session beats a same-age cloud copy. Expired persistent cookies are dropped so the
 * cloud set does not grow forever. Never deletes a live cookie.
 */
export function mergeCookieSets(base: SavedCookie[], override: SavedCookie[]): SavedCookie[] {
  const nowUs = chromeNowUs()
  // `override` (the live machine's export) is inserted FIRST so that, if the row cap ever has to
  // cut, it cuts old base rows — never the fresh local-only ones (a Map keeps first-insertion
  // order; the final sort by last_update_utc makes the cut newest-first regardless).
  const out = new Map<string, SavedCookie>()
  for (const c of override) {
    const s = sanitizeSavedCookie(c)
    if (s && !cookieExpired(s, nowUs)) out.set(cookieKey(s), s)
  }
  for (const c of base) {
    const s = sanitizeSavedCookie(c)
    if (!s || cookieExpired(s, nowUs)) continue
    const k = cookieKey(s)
    const cur = out.get(k)
    if (!cur) {
      out.set(k, s)
      continue
    }
    // base (cloud) only beats override when it is newer by MORE than the skew tolerance
    const baseTs = Number(s.cols.last_update_utc ?? 0)
    const curTs = Number(cur.cols.last_update_utc ?? 0)
    if (baseTs > curTs + SKEW_TOLERANCE_US) out.set(k, s)
  }
  const rows = [...out.values()]
  if (rows.length > MAX_COOKIE_ROWS) {
    rows.sort((a, b) => Number(b.cols.last_update_utc ?? 0) - Number(a.cols.last_update_utc ?? 0))
  }
  return rows.slice(0, MAX_COOKIE_ROWS)
}

/** Union of two login sets by unique key; newer `date_password_modified` wins, `override`
 *  wins near-ties (skew tolerance). Never deletes. */
export function mergeLoginSets(base: SavedLogin[], override: SavedLogin[]): SavedLogin[] {
  const out = new Map<string, SavedLogin>()
  for (const l of override) {
    const s = sanitizeLogin(l)
    if (s) out.set(loginKey(s), s)
  }
  for (const l of base) {
    const s = sanitizeLogin(l)
    if (!s) continue
    const k = loginKey(s)
    const cur = out.get(k)
    if (!cur) {
      out.set(k, s)
      continue
    }
    if ((s.date_password_modified ?? 0) > (cur.date_password_modified ?? 0) + SKEW_TOLERANCE_US) {
      out.set(k, s)
    }
  }
  const rows = [...out.values()]
  if (rows.length > MAX_LOGIN_ROWS) {
    rows.sort(
      (a, b) =>
        (b.date_password_modified ?? b.date_created ?? 0) - (a.date_password_modified ?? a.date_created ?? 0)
    )
  }
  return rows.slice(0, MAX_LOGIN_ROWS)
}

/** Options for the import-side merge. */
export interface ImportOptions {
  /** The incoming rows were uploaded by ANOTHER machine (a hand-off): by protocol they are the
   *  fresher session, so an incoming row also wins near-ties within the clock-skew tolerance.
   *  false (rows uploaded by THIS machine): strict newer-wins — a local row that is newer at all
   *  (e.g. a cookie the site rotated after a failed upload) is kept. */
  preferIncoming?: boolean
}

function safeRm(p: string): void {
  try {
    rmSync(p, { force: true })
  } catch {
    /* best-effort */
  }
}

function hasPendingSqliteWrites(path: string): boolean {
  try {
    return ['-journal', '-wal'].some((suffix) => {
      const sidecar = path + suffix
      if (!existsSync(sidecar)) return false
      const stat = lstatSync(sidecar)
      return !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 0
    })
  } catch {
    return true
  }
}

function readBoundedFile(path: string, maxBytes: number): Buffer {
  let fd: number | null = null
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error('Refusing unsafe database path')
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error(`Refusing unexpected database size: ${stat.size}`)
    }
    const bytes = readFileSync(fd)
    if (bytes.length <= 0 || bytes.length > maxBytes) {
      throw new Error(`Refusing unexpected database bytes: ${bytes.length}`)
    }
    return bytes
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function replaceDbAtomically(path: string, bytes: Buffer, maxBytes: number): void {
  if (bytes.length <= 0 || bytes.length > maxBytes) {
    throw new Error(`Refusing unexpected database output size: ${bytes.length}`)
  }
  const tmp = `${path}.vgcnew.${process.pid}.${randomBytes(8).toString('hex')}`
  try {
    const current = lstatSync(path)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
      throw new Error('Refusing unsafe database destination')
    }
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    safeRm(tmp)
  }
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\0/g, '').slice(0, max)
}

function boundedSecret(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_SECRET_CHARS) : ''
}

function boundedInteger(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) <= 9e18 ? Math.trunc(n) : fallback
}

function sanitizeLogin(value: unknown): SavedLogin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Partial<SavedLogin>
  const origin = boundedString(row.origin_url, 4096)
  const realm = boundedString(row.signon_realm, 4096)
  const password = boundedSecret(row.password)
  if (!origin || !realm || !password) return null
  return {
    origin_url: origin,
    signon_realm: realm,
    password,
    action_url: boundedString(row.action_url, 4096),
    username_element: boundedString(row.username_element, 1024),
    username_value: boundedString(row.username_value, 4096),
    password_element: boundedString(row.password_element, 1024),
    scheme: boundedInteger(row.scheme),
    date_created: boundedInteger(row.date_created),
    date_password_modified: boundedInteger(row.date_password_modified),
    times_used: Math.max(0, boundedInteger(row.times_used)),
    blacklisted_by_user: row.blacklisted_by_user === 1 ? 1 : 0
  }
}

function sanitizeSavedCookie(value: unknown): SavedCookie | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Partial<SavedCookie>
  if (!row.cols || typeof row.cols !== 'object' || Array.isArray(row.cols)) return null
  const cols: Record<string, string | number> = {}
  for (const [key, raw] of Object.entries(row.cols).slice(0, 128)) {
    if (!SAFE_COLUMN_RE.test(key)) continue
    if (typeof raw === 'number') {
      if (Number.isFinite(raw) && Math.abs(raw) <= 9e18) cols[key] = Math.trunc(raw)
    } else if (typeof raw === 'string') {
      cols[key] = boundedString(raw, MAX_SECRET_CHARS)
    }
  }
  cols.host_key = boundedString(cols.host_key, 255)
  cols.name = boundedString(cols.name, 1024)
  cols.path = boundedString(cols.path, 2048) || '/'
  if (!cols.host_key || !cols.name) return null
  return { value: boundedString(row.value, MAX_SECRET_CHARS), cols }
}

const SELECT_COLS = [
  'origin_url',
  'action_url',
  'username_element',
  'username_value',
  'password_element',
  'password_value',
  'signon_realm',
  'scheme',
  'date_created',
  'date_password_modified',
  'times_used',
  'blacklisted_by_user'
]

/**
 * Read + DECRYPT the profile's saved logins with the LOCAL key. Returns [] on any
 * problem (no engine key, no DB, WASM missing). Read-only — never touches the file.
 */
export async function exportLogins(userDataDir: string, _id: string): Promise<SavedLogin[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return []
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) return []
  if (hasPendingSqliteWrites(ld)) {
    dbg(`[vgc-pw ${_id}] exportLogins skipped: Login Data has a pending journal/WAL (engine still writing or killed)`)
    return []
  }
  const ek = await engineKey(userDataDir)
  if (!ek) {
    dbg(`[vgc-pw ${_id}] exportLogins skipped: machine os_crypt key unavailable`)
    return []
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readBoundedFile(ld, MAX_LOGIN_DB_BYTES))
    const res = db.exec(`SELECT ${SELECT_COLS.join(', ')} FROM logins`)
    const out: SavedLogin[] = []
    if (res.length) {
      const cols: string[] = res[0].columns
      const idx = (c: string): number => cols.indexOf(c)
      for (const row of res[0].values as unknown[][]) {
        if (out.length >= MAX_LOGIN_ROWS) break
        const pv = row[idx('password_value')] as Uint8Array | null
        if (!pv || !pv.length) continue // blacklist "never save" rows have no password
        const pb = decryptEngine(Buffer.from(pv), ek)
        const plain = pb === null ? null : pb.toString('utf8')
        if (plain == null || plain === '') continue // couldn't decrypt / empty → skip
        const login = sanitizeLogin({
          origin_url: String(row[idx('origin_url')] ?? ''),
          signon_realm: String(row[idx('signon_realm')] ?? ''),
          password: plain,
          action_url: (row[idx('action_url')] as string) ?? '',
          username_element: (row[idx('username_element')] as string) ?? '',
          username_value: (row[idx('username_value')] as string) ?? '',
          password_element: (row[idx('password_element')] as string) ?? '',
          scheme: Number(row[idx('scheme')] ?? 0),
          date_created: Number(row[idx('date_created')] ?? 0),
          date_password_modified: Number(row[idx('date_password_modified')] ?? 0),
          times_used: Number(row[idx('times_used')] ?? 0),
          blacklisted_by_user: Number(row[idx('blacklisted_by_user')] ?? 0)
        })
        if (login) out.push(login)
      }
    }
    return out
  } catch (e) {
    console.error('[vgc-pw] exportLogins failed:', e)
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * MERGE cloud logins into the profile's Login Data, RE-ENCRYPTING each with the LOCAL
 * key. Adds new logins (by origin/username/realm) and updates a password only when the
 * incoming copy is NEWER. Never deletes. Everything happens in memory; the file is only
 * replaced (atomically) if the merged DB passes an integrity_check. Returns how many
 * rows were added/updated (0 on skip/error).
 */
export async function importLogins(
  userDataDir: string,
  _id: string,
  logins: SavedLogin[],
  opts: ImportOptions = {}
): Promise<number> {
  if (!Array.isArray(logins) || !logins.length) return 0
  const tolerance = opts.preferIncoming ? SKEW_TOLERANCE_US : 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) {
    dbg(`[vgc-pw ${_id}] importLogins skipped: no Login Data yet (engine makes it on first run)`)
    return 0
  }
  const ek = await engineKey(userDataDir)
  if (!ek) {
    dbg(`[vgc-pw ${_id}] importLogins skipped: machine os_crypt key unavailable`)
    return 0
  }

  // sql.js reads only the main file. Skip while a rollback journal or WAL has pending
  // bytes so a merge cannot discard a transaction Chromium has not checkpointed yet.
  if (hasPendingSqliteWrites(ld)) {
    dbg(`[vgc-pw ${_id}] importLogins skipped: Login Data has a pending journal/WAL`)
    return 0
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readBoundedFile(ld, MAX_LOGIN_DB_BYTES))

    // Only write known columns that exist in this VGC Core schema; extra columns retain
    // SQLite defaults. Reject malformed schemas before constructing any SQL from them.
    const ti = db.exec('PRAGMA table_info(logins)')
    if (!ti.length) {
      db.close()
      return 0
    }
    const nameIdx = (ti[0].columns as string[]).indexOf('name')
    if (nameIdx < 0 || ti[0].values.length > 128) {
      db.close()
      return 0
    }
    const schemaColumns = (ti[0].values as unknown[][]).map((v) => String(v[nameIdx]))
    if (schemaColumns.some((column) => !SAFE_COLUMN_RE.test(column))) {
      db.close()
      return 0
    }
    const cols = new Set<string>(schemaColumns)
    const requiredColumns = [
      'id',
      'origin_url',
      'username_element',
      'username_value',
      'password_element',
      'password_value',
      'signon_realm',
      'date_password_modified'
    ]
    if (requiredColumns.some((column) => !cols.has(column))) {
      db.close()
      return 0
    }
    const wanted = [
      'origin_url',
      'action_url',
      'username_element',
      'username_value',
      'password_element',
      'password_value',
      'signon_realm',
      'scheme',
      'date_created',
      'blacklisted_by_user',
      'date_password_modified',
      'times_used'
    ].filter((c) => cols.has(c))

    // NULL-safe match: Chrome may store NULL (not '') in the element columns, and the
    // UNIQUE index treats NULL as distinct — a plain `=''` would miss it and we'd INSERT
    // a DUPLICATE instead of updating. IFNULL(...,'') normalises both sides.
    const findStmt = db.prepare(
      `SELECT id, date_password_modified, password_value FROM logins
       WHERE origin_url=$o AND IFNULL(username_element,'')=$ue AND IFNULL(username_value,'')=$uv
         AND IFNULL(password_element,'')=$pe AND signon_realm=$sr`
    )
    const insSql = `INSERT OR IGNORE INTO logins (${wanted.join(',')}) VALUES (${wanted
      .map((c) => '$' + c)
      .join(',')})`

    let changed = 0
    db.exec('BEGIN')
    try {
      for (const raw of logins.slice(0, MAX_LOGIN_ROWS)) {
        const r = sanitizeLogin(raw)
        if (!r) continue
        const ue = r.username_element ?? ''
        const pe = r.password_element ?? ''
        const uv = r.username_value ?? ''
        const pv = encryptEngine(r.password, ek)

        findStmt.bind({ $o: r.origin_url, $ue: ue, $uv: uv, $pe: pe, $sr: r.signon_realm })
        type ExistingRow = {
          id: number
          date_password_modified: number
          password_value: Uint8Array | null
        }
        let existing: ExistingRow | null = null
        if (findStmt.step()) existing = findStmt.getAsObject() as unknown as ExistingRow
        findStmt.reset()

        if (existing) {
          // Overwrite the local row when EITHER the incoming copy is newer, OR the local
          // blob is UNREADABLE with our key (i.e. it was written by the OTHER machine's
          // engine and is currently useless here) — that recovers the cross-machine
          // blobs the wholesale-overwrite left undecryptable. Never regress the timestamp.
          const localReadable =
            existing.password_value && existing.password_value.length
              ? decryptEngine(Buffer.from(existing.password_value), ek) !== null
              : false
          // "Newer" with an optional clock-skew tolerance (hand-off from another machine): the
          // local copy only wins when it is newer by MORE than the tolerance — otherwise two
          // machines with slightly different clocks would each keep their own stale copy.
          // Rows this machine uploaded itself use strict newer-wins (tolerance 0).
          const incomingNewer =
            (r.date_password_modified ?? 0) + tolerance >= (existing.date_password_modified ?? 0) &&
            (tolerance > 0 || (r.date_password_modified ?? 0) > (existing.date_password_modified ?? 0))
          if (!localReadable || incomingNewer) {
            // We write the INCOMING content, so stamp it with the INCOMING record's own
            // date (never Math.max: reusing a newer FOREIGN date on incoming content would
            // let stale content beat a genuinely-newer copy elsewhere on the next sync).
            db.run('UPDATE logins SET password_value=$pv, date_password_modified=$d WHERE id=$id', {
              $pv: pv,
              $d: r.date_password_modified ?? 0,
              $id: existing.id
            })
            changed++
          }
        } else {
          const val: Record<string, unknown> = {
            origin_url: r.origin_url,
            action_url: r.action_url ?? '',
            username_element: ue,
            username_value: uv,
            password_element: pe,
            password_value: pv,
            signon_realm: r.signon_realm,
            scheme: r.scheme ?? 0,
            date_created: r.date_created ?? 0,
            blacklisted_by_user: r.blacklisted_by_user ?? 0,
            date_password_modified: r.date_password_modified ?? 0,
            times_used: r.times_used ?? 0
          }
          const params: Record<string, unknown> = {}
          for (const c of wanted) params['$' + c] = val[c]
          db.run(insSql, params)
          // INSERT OR IGNORE may have skipped on a UNIQUE clash — only count real writes
          // so `changed===0` can correctly avoid an unnecessary full-file rewrite.
          if (db.getRowsModified() > 0) changed++
        }
      }
      db.exec('COMMIT')
    } catch (inner) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw inner
    } finally {
      findStmt.free()
    }

    if (changed === 0) {
      db.close()
      return 0 // nothing new — leave the file untouched
    }

    // Verify the mutated DB before it ever reaches disk.
    const integ = db.exec('PRAGMA integrity_check')
    const ok = integ.length && String(integ[0].values[0][0]) === 'ok'
    if (!ok) {
      db.close()
      console.error('[vgc-pw] integrity_check failed after merge — file left unchanged')
      return 0
    }

    const outBytes = Buffer.from(db.export() as Uint8Array)
    db.close()
    db = null

    // Atomic replace: write a sibling then rename over the original so a crash mid-write
    // can never leave a truncated Login Data. Drop stale journal/WAL siblings so the
    // engine reads exactly our merged DB.
    if (hasPendingSqliteWrites(ld)) throw new Error('Login Data changed during merge')
    replaceDbAtomically(ld, outBytes, MAX_LOGIN_DB_BYTES)
    safeRm(ld + '-wal')
    safeRm(ld + '-shm')
    safeRm(ld + '-journal')
    return changed
  } catch (e) {
    console.error('[vgc-pw] importLogins failed (file left unchanged):', e)
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    return 0
  }
}

// ── Cookies (login SESSION) — decrypt on source, re-encrypt on target ─────────
// The `cookies` table's `encrypted_value` is os_crypt v10 with, since DB version 24, a
// SHA256(host_key) prefix on the decrypted plaintext (net/extras/sqlite/sqlite_persistent
// _cookie_store.cc:213,992-999). We decrypt with the LOCAL key + strip that prefix on
// export; on import we restore the prefix and encrypt immediately with the target's LOCAL
// key. Cookie secrets therefore never need to sit in SQLite's plaintext `value` column.

function cookiesDbPath(userDataDir: string): string {
  return join(userDataDir, 'Default', 'Network', 'Cookies')
}

/** AES-256-GCM v10 decrypt (the Windows machine DPAPI key format). A non-null result
 *  means the auth tag verified → the blob was written by the machine key. */
function decryptV10Gcm(blob: Buffer, key: Buffer): Buffer | null {
  try {
    if (blob.length < 3 + 12 + 16 || !blob.subarray(0, 3).equals(V10)) return null
    const nonce = blob.subarray(3, 15)
    const tag = blob.subarray(blob.length - 16)
    const ct = blob.subarray(15, blob.length - 16)
    const d = createDecipheriv('aes-256-gcm', key, nonce)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()])
  } catch {
    return null
  }
}

// Per-profile Windows machine os_crypt key (AES-256) from Local State via DPAPI. Cached only
// on SUCCESS: a slow PowerShell start or a transient DPAPI error is retried on the next call
// instead of silently disabling the bridge for the rest of the app session. Async so the
// PowerShell call never blocks the main process; concurrent callers share one lookup.
const winMachineKeyCache = new Map<string, Buffer>()
const winMachineKeyInFlight = new Map<string, Promise<Buffer | null>>()
async function windowsMachineKey(userDataDir: string): Promise<Buffer | null> {
  if (process.platform !== 'win32') return null
  const cached = winMachineKeyCache.get(userDataDir)
  if (cached) return cached
  const inFlight = winMachineKeyInFlight.get(userDataDir)
  if (inFlight) return inFlight
  const lookup = (async (): Promise<Buffer | null> => {
    try {
      const ls = join(userDataDir, 'Local State')
      if (!existsSync(ls)) return null
      const j = JSON.parse(readBoundedFile(ls, MAX_LOCAL_STATE_BYTES).toString('utf8')) as {
        os_crypt?: { encrypted_key?: string }
      }
      const b64 = j.os_crypt?.encrypted_key
      if (!b64 || b64.length > 16 * 1024 || !/^[a-z0-9+/]+=*$/i.test(b64)) return null
      const raw = Buffer.from(b64, 'base64')
      if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') return null
      const dpapiB64 = raw.subarray(5).toString('base64')
      const ps = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${dpapiB64}'),$null,'CurrentUser'))`
      const out = await execFileText('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 20_000)
      const k = Buffer.from(out, 'base64')
      if (k.length !== 32) return null
      winMachineKeyCache.set(userDataDir, k)
      return k
    } catch (e) {
      dbg(`[vgc-pw] Windows DPAPI key read failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      winMachineKeyInFlight.delete(userDataDir)
    }
  })()
  winMachineKeyInFlight.set(userDataDir, lookup)
  return lookup
}

/** Read + DECRYPT the profile's cookies with the LOCAL key. [] on any problem. */
export async function exportCookies(userDataDir: string, _id: string): Promise<SavedCookie[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return []
  const ck = cookiesDbPath(userDataDir)
  if (!existsSync(ck)) return []
  if (hasPendingSqliteWrites(ck)) {
    dbg(`[vgc-pw ${_id}] exportCookies skipped: Cookies DB has a pending journal/WAL (engine still writing or killed)`)
    return []
  }
  const ek = await engineKey(userDataDir)
  if (!ek) {
    dbg(`[vgc-pw ${_id}] exportCookies skipped: machine os_crypt key unavailable`)
    return []
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readBoundedFile(ck, MAX_COOKIE_DB_BYTES))
    const ti = db.exec('PRAGMA table_info(cookies)')
    if (!ti.length) {
      db.close()
      return []
    }
    const nIdx = (ti[0].columns as string[]).indexOf('name')
    if (nIdx < 0) {
      db.close()
      return []
    }
    const allCols = (ti[0].values as unknown[][]).map((v) => String(v[nIdx]))
    const required = ['host_key', 'name', 'value', 'encrypted_value']
    if (
      allCols.length > 128 ||
      allCols.some((column) => !SAFE_COLUMN_RE.test(column)) ||
      required.some((column) => !allCols.includes(column))
    ) {
      db.close()
      return []
    }
    const res = db.exec(`SELECT ${allCols.map((c) => `"${c}"`).join(',')} FROM cookies`)
    const out: SavedCookie[] = []
    if (res.length) {
      const cols: string[] = res[0].columns
      const ix = (c: string): number => cols.indexOf(c)
      const hostI = ix('host_key')
      const evI = ix('encrypted_value')
      const valI = ix('value')
      for (const row of res[0].values as unknown[][]) {
        if (out.length >= MAX_COOKIE_ROWS) break
        const host = String(row[hostI] ?? '')
        const ev = row[evI] as Uint8Array | null
        let value: string
        if (ev && ev.length) {
          const pt = decryptEngine(Buffer.from(ev), ek)
          if (!pt) continue // wrong key / not ours
          // Strip the SHA256(host_key) domain prefix (cookies DB v24+). A mismatch also
          // reliably filters wrong-key garbage that happened to unpad cleanly.
          const sha = createHash('sha256').update(host).digest()
          if (pt.length < 32 || !pt.subarray(0, 32).equals(sha)) continue
          value = pt.subarray(32).toString('utf8')
        } else {
          value = String(row[valI] ?? '') // already-plaintext cookie
        }
        const c: Record<string, string | number> = {}
        for (const col of cols) {
          if (col === 'value' || col === 'encrypted_value') continue
          const v = row[ix(col)]
          c[col] = typeof v === 'number' ? v : v == null ? '' : String(v)
        }
        const cookie = sanitizeSavedCookie({ value, cols: c })
        if (cookie) out.push(cookie)
      }
    }
    return out
  } catch (e) {
    console.error('[vgc-pw] exportCookies failed:', e)
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/** MERGE cloud cookies into the local Cookies DB, encrypted with the target machine key.
 *  INSERT-OR-REPLACE by the cookie unique index. Fail-safe atomic write. Returns count. */
export async function importCookies(
  userDataDir: string,
  _id: string,
  cookies: SavedCookie[],
  opts: ImportOptions = {}
): Promise<number> {
  if (!Array.isArray(cookies) || !cookies.length) return 0
  const tolerance = opts.preferIncoming ? SKEW_TOLERANCE_US : 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ck = cookiesDbPath(userDataDir)
  if (!existsSync(ck)) {
    dbg(`[vgc-pw ${_id}] importCookies skipped: no Cookies DB yet (engine makes it on first run)`)
    return 0
  }
  const ek = await engineKey(userDataDir)
  if (!ek) {
    dbg(`[vgc-pw ${_id}] importCookies skipped: machine os_crypt key unavailable`)
    return 0
  }

  if (hasPendingSqliteWrites(ck)) {
    dbg(`[vgc-pw ${_id}] importCookies skipped: Cookies DB has a pending journal/WAL`)
    return 0
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readBoundedFile(ck, MAX_COOKIE_DB_BYTES))
    const ti = db.exec('PRAGMA table_info(cookies)')
    if (!ti.length) {
      db.close()
      return 0
    }
    const pcols = ti[0].columns as string[]
    const nIdx = pcols.indexOf('name')
    const tIdx = pcols.indexOf('type')
    if (nIdx < 0 || tIdx < 0) {
      db.close()
      return 0
    }
    const targetCols = (ti[0].values as unknown[][]).map((v) => String(v[nIdx]))
    const required = [
      'host_key',
      'top_frame_site_key',
      'has_cross_site_ancestor',
      'name',
      'path',
      'source_scheme',
      'source_port',
      'last_update_utc',
      'value',
      'encrypted_value'
    ]
    if (
      targetCols.length > 128 ||
      targetCols.some((column) => !SAFE_COLUMN_RE.test(column)) ||
      required.some((column) => !targetCols.includes(column))
    ) {
      db.close()
      return 0
    }
    const colIsInt: Record<string, boolean> = {}
    for (const v of ti[0].values as unknown[][]) {
      colIsInt[String(v[nIdx])] = String(v[tIdx]).toUpperCase().includes('INT')
    }
    const insSql = `INSERT OR REPLACE INTO cookies (${targetCols
      .map((c) => `"${c}"`)
      .join(',')}) VALUES (${targetCols.map((c) => '$' + c).join(',')})`
    // Find the matching local cookie (by the cookies unique index) so we never clobber a
    // FRESHER local cookie with an older cloud copy — that would log the user out on this
    // machine. Only overwrite when the incoming (cloud) copy is newer-or-equal.
    const findStmt = db.prepare(
      `SELECT last_update_utc FROM cookies
       WHERE host_key=$hk AND IFNULL(top_frame_site_key,'')=$tf
         AND has_cross_site_ancestor=$hca AND name=$nm AND IFNULL(path,'')=$pa
         AND source_scheme=$ss AND source_port=$sp`
    )

    let changed = 0
    db.exec('BEGIN')
    try {
      for (const raw of cookies.slice(0, MAX_COOKIE_ROWS)) {
        const r = sanitizeSavedCookie(raw)
        if (!r) continue
        findStmt.bind({
          $hk: r.cols.host_key,
          $tf: String(r.cols.top_frame_site_key ?? ''),
          $hca: Number(r.cols.has_cross_site_ancestor ?? 0),
          $nm: r.cols.name,
          $pa: String(r.cols.path ?? ''),
          $ss: Number(r.cols.source_scheme ?? 0),
          $sp: Number(r.cols.source_port ?? 0)
        })
        const localRow = findStmt.step()
          ? (findStmt.getAsObject() as { last_update_utc?: number })
          : null
        findStmt.reset()
        if (
          localRow &&
          Number(localRow.last_update_utc ?? 0) > Number(r.cols.last_update_utc ?? 0) + tolerance
        ) {
          continue // local cookie is newer (beyond the tolerance, if any) → keep it
        }
        const params: Record<string, unknown> = {}
        const host = String(r.cols.host_key)
        const protectedValue = encryptEngineBytes(
          Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(r.value, 'utf8')]),
          ek
        )
        for (const c of targetCols) {
          if (c === 'value') params['$' + c] = ''
          else if (c === 'encrypted_value') params['$' + c] = protectedValue
          else if (Object.prototype.hasOwnProperty.call(r.cols, c)) params['$' + c] = r.cols[c]
          else params['$' + c] = colIsInt[c] ? 0 : '' // NOT NULL default for a target-only column
        }
        db.run(insSql, params)
        if (db.getRowsModified() > 0) changed++
      }
      db.exec('COMMIT')
    } catch (inner) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw inner
    } finally {
      findStmt.free()
    }

    if (changed === 0) {
      db.close()
      return 0
    }
    const integ = db.exec('PRAGMA integrity_check')
    const ok = integ.length && String(integ[0].values[0][0]) === 'ok'
    if (!ok) {
      db.close()
      console.error('[vgc-pw] cookies integrity_check failed — file left unchanged')
      return 0
    }
    const outBytes = Buffer.from(db.export() as Uint8Array)
    db.close()
    db = null
    if (hasPendingSqliteWrites(ck)) throw new Error('Cookies DB changed during merge')
    replaceDbAtomically(ck, outBytes, MAX_COOKIE_DB_BYTES)
    safeRm(ck + '-wal')
    safeRm(ck + '-shm')
    safeRm(ck + '-journal')
    return changed
  } catch (e) {
    console.error('[vgc-pw] importCookies failed (file left unchanged):', e)
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    return 0
  }
}
