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
import { execFileSync } from 'child_process'
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

// macOS keychain-derived key, resolved at most once per process (undefined = untried,
// null = unavailable). Machine-wide: VGC Core uses one key for all profiles.
let macKeyCache: Buffer | null | undefined

function loginDataPath(userDataDir: string): string {
  return join(userDataDir, 'Default', 'Login Data')
}

/**
 * The LOCAL machine's os_crypt AES-128 key for a profile, or null if it can't be
 * derived (→ bridge skips, safely). Mirrors exactly what the running engine uses so
 * blobs we write are readable by it and blobs it wrote are readable by us.
 */
async function localKey(): Promise<Buffer | null> {
  try {
    if (process.platform === 'darwin') {
      // The dedicated engine is Chromium-branded, so it uses these exact Keychain names.
      // Never fall back to Google Chrome's item: a valid but wrong key would make imported
      // credentials unreadable. The first read may show a macOS permission prompt.
      if (macKeyCache !== undefined) return macKeyCache
      let pw = ''
      try {
        pw = execFileSync(
          'security',
          ['find-generic-password', '-w', '-s', 'Chromium Safe Storage', '-a', 'Chromium'],
          { encoding: 'utf8', timeout: 90000 }
        ).trim()
      } catch {
        pw = ''
      }
      macKeyCache = pw ? pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1') : null
      if (!macKeyCache) console.error('[vgc-pw] macOS keychain key unavailable — grant "Always Allow" once')
      return macKeyCache
    }
    return null // Linux: system Chrome text/basic-storage varies — bridge off for now.
  } catch {
    return null
  }
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
    const k = windowsMachineKey(userDataDir)
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
  if (hasPendingSqliteWrites(ld)) return []
  const ek = await engineKey(userDataDir)
  if (!ek) return []

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
  logins: SavedLogin[]
): Promise<number> {
  if (!Array.isArray(logins) || !logins.length) return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) return 0 // no schema to merge into (engine makes it on first run)
  const ek = await engineKey(userDataDir)
  if (!ek) return 0

  // sql.js reads only the main file. Skip while a rollback journal or WAL has pending
  // bytes so a merge cannot discard a transaction Chromium has not checkpointed yet.
  if (hasPendingSqliteWrites(ld)) return 0

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
          const incomingNewer = (r.date_password_modified ?? 0) > (existing.date_password_modified ?? 0)
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

// Per-profile Windows machine os_crypt key (AES-256) from Local State via DPAPI. Cached.
const winMachineKeyCache = new Map<string, Buffer | null>()
function windowsMachineKey(userDataDir: string): Buffer | null {
  if (process.platform !== 'win32') return null
  if (winMachineKeyCache.has(userDataDir)) return winMachineKeyCache.get(userDataDir) ?? null
  let key: Buffer | null = null
  try {
    const ls = join(userDataDir, 'Local State')
    if (existsSync(ls)) {
      const j = JSON.parse(readBoundedFile(ls, MAX_LOCAL_STATE_BYTES).toString('utf8')) as {
        os_crypt?: { encrypted_key?: string }
      }
      const b64 = j.os_crypt?.encrypted_key
      if (b64 && b64.length <= 16 * 1024 && /^[a-z0-9+/]+=*$/i.test(b64)) {
        const raw = Buffer.from(b64, 'base64')
        if (raw.subarray(0, 5).toString('latin1') === 'DPAPI') {
          const dpapiB64 = raw.subarray(5).toString('base64')
          const ps = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${dpapiB64}'),$null,'CurrentUser'))`
          const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            encoding: 'utf8',
            timeout: 10000
          }).trim()
          const k = Buffer.from(out, 'base64')
          if (k.length === 32) key = k
        }
      }
    }
  } catch {
    key = null
  }
  winMachineKeyCache.set(userDataDir, key)
  return key
}

/** Read + DECRYPT the profile's cookies with the LOCAL key. [] on any problem. */
export async function exportCookies(userDataDir: string, _id: string): Promise<SavedCookie[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return []
  const ck = cookiesDbPath(userDataDir)
  if (!existsSync(ck)) return []
  if (hasPendingSqliteWrites(ck)) return []
  const ek = await engineKey(userDataDir)
  if (!ek) return []

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
  cookies: SavedCookie[]
): Promise<number> {
  if (!Array.isArray(cookies) || !cookies.length) return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ck = cookiesDbPath(userDataDir)
  if (!existsSync(ck)) return 0 // engine creates it on first run
  const ek = await engineKey(userDataDir)
  if (!ek) return 0

  if (hasPendingSqliteWrites(ck)) return 0

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
        if (localRow && Number(localRow.last_update_utc ?? 0) > Number(r.cols.last_update_utc ?? 0)) {
          continue // local cookie is newer → keep it (don't clobber a fresh session)
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
