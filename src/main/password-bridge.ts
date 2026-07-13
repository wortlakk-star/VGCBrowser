// ── VGC Browser — cross-machine SAVED PASSWORDS bridge ───────────────────────
// Chrome stores saved website logins in the `Default/Login Data` SQLite DB with each
// password ENCRYPTED by the machine's os_crypt key. That key differs per engine:
//   • Windows runs the patched VGC Core → PORTABLE key = PBKDF2-SHA1(sha256(accountSecret
//     :profileId), "saltysalt", 1003) → AES-128-CBC, tag "v10".
//   • macOS runs the SYSTEM Google Chrome → KEYCHAIN key = PBKDF2-SHA1("Chrome Safe
//     Storage" keychain password, "saltysalt", 1003) → AES-128-CBC, tag "v10".
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
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'fs'
import { join, dirname } from 'path'
import type { SavedLogin, SavedCookie } from '../shared/types'
import { getAccountSecret } from './account-secret'
import { getSettings } from './settings'

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

// macOS keychain-derived key, resolved at most once per process (undefined = untried,
// null = unavailable). Machine-wide: stock Chrome uses one key for all profiles.
let macKeyCache: Buffer | null | undefined

function loginDataPath(userDataDir: string): string {
  return join(userDataDir, 'Default', 'Login Data')
}

/**
 * The LOCAL machine's os_crypt AES-128 key for a profile, or null if it can't be
 * derived (→ bridge skips, safely). Mirrors exactly what the running engine uses so
 * blobs we write are readable by it and blobs it wrote are readable by us.
 */
async function localKey(id: string): Promise<Buffer | null> {
  try {
    const s = await getSettings()
    if (process.platform === 'win32') {
      // System Chrome on Windows uses DPAPI/AES-256-GCM (different format) — skip.
      if (s.useSystemBrowser) return null
      const acct = await getAccountSecret()
      if (!acct) return null
      const secretStr = createHash('sha256').update(`${acct}:${id}`).digest('hex')
      return pbkdf2Sync(secretStr, 'saltysalt', 1003, 16, 'sha1')
    }
    if (process.platform === 'darwin') {
      // System Google Chrome → the "Chrome Safe Storage" keychain password. It's the
      // SAME key for every profile on this Mac (stock Chrome knows nothing about
      // per-profile keys), so read + cache it once per process. The keychain item's ACL
      // trusts only Chrome, so the FIRST read shows a macOS prompt — give the user time
      // to click "Always Allow" (90s) rather than SIGKILLing it with a short timeout.
      if (macKeyCache !== undefined) return macKeyCache
      let pw = ''
      try {
        pw = execFileSync(
          'security',
          ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
          { encoding: 'utf8', timeout: 90000 }
        ).trim()
      } catch {
        try {
          pw = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], {
            encoding: 'utf8',
            timeout: 90000
          }).trim()
        } catch {
          pw = ''
        }
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
  const c = createCipheriv('aes-128-cbc', key, FIXED_IV)
  return Buffer.concat([V10, c.update(Buffer.from(plain, 'utf8')), c.final()])
}

// AES-256-GCM v10 encrypt (the Windows machine-key format). "v10" + nonce[12] + ct + tag[16].
function encryptV10Gcm(plain: string, key: Buffer): Buffer {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()])
  return Buffer.concat([V10, nonce, ct, c.getAuthTag()])
}

// ── The key the ENGINE actually uses (Option B: machine key, engine-agnostic) ─
// The VGC Core engine does NOT apply the portable --vgc-crypt-secret key (verified: it
// keeps writing the per-machine DPAPI key). So the bridge decrypts/encrypts with the SAME
// per-machine key the engine uses — Windows: DPAPI AES-256-GCM (from Local State); macOS:
// system-Chrome "Chrome Safe Storage" keychain AES-128-CBC. That makes each machine keep
// its own stable session AND lets the bridge translate cookies/passwords across machines
// (decrypt local → plaintext cloud → re-encrypt with the TARGET machine's key), no engine
// rebuild needed.
type EngKey = { key: Buffer; gcm: boolean }
async function engineKey(userDataDir: string, id: string): Promise<EngKey | null> {
  if (process.platform === 'win32') {
    const k = windowsMachineKey(userDataDir)
    return k ? { key: k, gcm: true } : null
  }
  if (process.platform === 'darwin') {
    const k = await localKey(id) // macOS localKey = the keychain (machine) key, AES-128-CBC
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

function safeRm(p: string): void {
  try {
    rmSync(p, { force: true })
  } catch {
    /* best-effort */
  }
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
export async function exportLogins(userDataDir: string, id: string): Promise<SavedLogin[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return []
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) return []
  const ek = await engineKey(userDataDir, id)
  if (!ek) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readFileSync(ld))
    const res = db.exec(`SELECT ${SELECT_COLS.join(', ')} FROM logins`)
    const out: SavedLogin[] = []
    if (res.length) {
      const cols: string[] = res[0].columns
      const idx = (c: string): number => cols.indexOf(c)
      for (const row of res[0].values as unknown[][]) {
        const pv = row[idx('password_value')] as Uint8Array | null
        if (!pv || !pv.length) continue // blacklist "never save" rows have no password
        const pb = decryptEngine(Buffer.from(pv), ek)
        const plain = pb === null ? null : pb.toString('utf8')
        if (plain == null || plain === '') continue // couldn't decrypt / empty → skip
        out.push({
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
      }
    }
    return out.filter((l) => l.origin_url && l.signon_realm)
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
  id: string,
  logins: SavedLogin[]
): Promise<number> {
  if (!logins?.length) return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) return 0 // no schema to merge into (engine makes it on first run)
  const ek = await engineKey(userDataDir, id)
  if (!ek) return 0

  // A leftover hot rollback journal means an interrupted transaction that a real SQLite
  // open would ROLL BACK; sql.js reads only the main file and can't, so skip this round
  // (no-op) rather than persist a half-state. It merges cleanly on the next open.
  try {
    const j = ld + '-journal'
    if (existsSync(j) && statSync(j).size > 0) return 0
  } catch {
    /* ignore */
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readFileSync(ld))

    // Only write columns that exist in THIS engine's schema (macOS system Chrome may be
    // a different version) — the rest fall back to their SQLite defaults.
    const ti = db.exec('PRAGMA table_info(logins)')
    if (!ti.length) {
      db.close()
      return 0
    }
    const nameIdx = (ti[0].columns as string[]).indexOf('name')
    const cols = new Set<string>((ti[0].values as unknown[][]).map((v) => String(v[nameIdx])))
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
      for (const r of logins) {
        if (!r.origin_url || !r.signon_realm || !r.password) continue
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
    const tmp = ld + '.vgcnew'
    writeFileSync(tmp, outBytes)
    renameSync(tmp, ld)
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

// ── Cookies (login SESSION) — decrypt-on-source, write-plaintext-on-target ────
// The `cookies` table's `encrypted_value` is os_crypt v10 with, since DB version 24, a
// SHA256(host_key) prefix on the decrypted plaintext (net/extras/sqlite/sqlite_persistent
// _cookie_store.cc:213,992-999). We decrypt with the LOCAL key + strip that prefix on
// export; on import we write the value into the plaintext `value` column with an EMPTY
// `encrypted_value`, so the target Chrome loads it directly (line 980 there) and re-seals
// it with ITS key on next save — no target-side re-encryption/hashing needed. All cookie
// columns are NOT NULL, so we carry every column and default anything a target adds.

function cookiesDbPath(userDataDir: string): string {
  return join(userDataDir, 'Default', 'Network', 'Cookies')
}

// ── One-time migration: OLD machine key → portable key ────────────────────────
// Before the --vgc-crypt-secret switch fix, the engine silently used its per-machine
// DPAPI key (AES-256-GCM, tag "v10"). After the fix it uses the portable key
// (AES-128-CBC). So existing cookies/passwords can't be read by the now-portable engine
// → mass re-login. This migrates them: decrypt with the OLD machine key (auth-tag-
// verified GCM = reliably a machine-key blob), then re-seal for the portable engine —
// cookies as PLAINTEXT (empty encrypted_value, engine re-seals on save), passwords by
// re-encrypting to portable CBC. Windows only (macOS runs stock Chrome/keychain). It is
// self-terminating (once migrated, GCM decrypt returns null → no-op) and fail-safe.

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
      const j = JSON.parse(readFileSync(ls, 'utf-8')) as { os_crypt?: { encrypted_key?: string } }
      const b64 = j.os_crypt?.encrypted_key
      if (b64) {
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

/** Re-seal machine-key cookies as plaintext so the portable-key engine keeps the session. */
export async function migrateCookiesToPortable(userDataDir: string, id: string): Promise<number> {
  if (process.platform !== 'win32') return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ck = cookiesDbPath(userDataDir)
  if (!existsSync(ck)) return 0
  const mkey = windowsMachineKey(userDataDir)
  if (!mkey) return 0
  try {
    const j = ck + '-journal'
    if (existsSync(j) && statSync(j).size > 0) return 0
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readFileSync(ck))
    const res = db.exec('SELECT rowid, host_key, encrypted_value FROM cookies WHERE length(encrypted_value)>30')
    if (!res.length) {
      db.close()
      return 0
    }
    let n = 0
    db.exec('BEGIN')
    try {
      for (const row of res[0].values as unknown[][]) {
        const rowid = row[0]
        const host = String(row[1] ?? '')
        const pt = decryptV10Gcm(Buffer.from(row[2] as Uint8Array), mkey)
        if (!pt) continue // not a machine-key blob (already portable / not ours)
        const sha = createHash('sha256').update(host).digest()
        const value =
          pt.length >= 32 && pt.subarray(0, 32).equals(sha) ? pt.subarray(32).toString('utf8') : pt.toString('utf8')
        db.run('UPDATE cookies SET encrypted_value=$e, value=$v WHERE rowid=$r', {
          $e: new Uint8Array(0),
          $v: value,
          $r: rowid
        })
        n++
      }
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw e
    }
    if (n === 0) {
      db.close()
      return 0
    }
    const integ = db.exec('PRAGMA integrity_check')
    if (!(integ.length && String(integ[0].values[0][0]) === 'ok')) {
      db.close()
      return 0
    }
    const out = Buffer.from(db.export() as Uint8Array)
    db.close()
    db = null
    const tmp = ck + '.vgcnew'
    writeFileSync(tmp, out)
    renameSync(tmp, ck)
    safeRm(ck + '-wal')
    safeRm(ck + '-shm')
    safeRm(ck + '-journal')
    return n
  } catch (e) {
    console.error('[vgc-pw] migrateCookiesToPortable failed:', e)
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    return 0
  }
}

/** Re-encrypt machine-key saved passwords to the portable key so autofill survives. */
export async function migrateLoginsToPortable(userDataDir: string, id: string): Promise<number> {
  if (process.platform !== 'win32') return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) return 0
  const portable = await localKey(id)
  const mkey = windowsMachineKey(userDataDir)
  if (!portable || !mkey) return 0
  try {
    const j = ld + '-journal'
    if (existsSync(j) && statSync(j).size > 0) return 0
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readFileSync(ld))
    const res = db.exec('SELECT rowid, password_value FROM logins WHERE length(password_value)>30')
    if (!res.length) {
      db.close()
      return 0
    }
    let n = 0
    db.exec('BEGIN')
    try {
      for (const row of res[0].values as unknown[][]) {
        const rowid = row[0]
        const pt = decryptV10Gcm(Buffer.from(row[1] as Uint8Array), mkey)
        if (!pt) continue
        const reenc = encryptV10(pt.toString('utf8'), portable)
        db.run('UPDATE logins SET password_value=$p WHERE rowid=$r', { $p: reenc, $r: rowid })
        n++
      }
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw e
    }
    if (n === 0) {
      db.close()
      return 0
    }
    const integ = db.exec('PRAGMA integrity_check')
    if (!(integ.length && String(integ[0].values[0][0]) === 'ok')) {
      db.close()
      return 0
    }
    const out = Buffer.from(db.export() as Uint8Array)
    db.close()
    db = null
    const tmp = ld + '.vgcnew'
    writeFileSync(tmp, out)
    renameSync(tmp, ld)
    safeRm(ld + '-wal')
    safeRm(ld + '-shm')
    safeRm(ld + '-journal')
    return n
  } catch (e) {
    console.error('[vgc-pw] migrateLoginsToPortable failed:', e)
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    return 0
  }
}

/** Read + DECRYPT the profile's cookies with the LOCAL key. [] on any problem. */
export async function exportCookies(userDataDir: string, id: string): Promise<SavedCookie[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return []
  const ck = cookiesDbPath(userDataDir)
  if (!existsSync(ck)) return []
  const ek = await engineKey(userDataDir, id)
  if (!ek) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readFileSync(ck))
    const ti = db.exec('PRAGMA table_info(cookies)')
    if (!ti.length) {
      db.close()
      return []
    }
    const nIdx = (ti[0].columns as string[]).indexOf('name')
    const allCols = (ti[0].values as unknown[][]).map((v) => String(v[nIdx]))
    const res = db.exec(`SELECT ${allCols.map((c) => `"${c}"`).join(',')} FROM cookies`)
    const out: SavedCookie[] = []
    if (res.length) {
      const cols: string[] = res[0].columns
      const ix = (c: string): number => cols.indexOf(c)
      const hostI = ix('host_key')
      const evI = ix('encrypted_value')
      const valI = ix('value')
      for (const row of res[0].values as unknown[][]) {
        const host = String(row[hostI] ?? '')
        const ev = row[evI] as Uint8Array | null
        let value: string
        if (ev && ev.length) {
          const pt = decryptV10Bytes(Buffer.from(ev), key)
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
        out.push({ value, cols: c })
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

/** MERGE cloud cookies into the local Cookies DB as PLAINTEXT (encrypted_value empty).
 *  INSERT-OR-REPLACE by the cookie unique index. Fail-safe atomic write. Returns count. */
export async function importCookies(
  userDataDir: string,
  id: string,
  cookies: SavedCookie[]
): Promise<number> {
  if (!cookies?.length) return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sql = (await getSQL()) as any
  if (!Sql) return 0
  const ck = cookiesDbPath(userDataDir)
  if (!existsSync(ck)) return 0 // engine creates it on first run

  try {
    const j = ck + '-journal'
    if (existsSync(j) && statSync(j).size > 0) return 0
  } catch {
    /* ignore */
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null
  try {
    db = new Sql.Database(readFileSync(ck))
    const ti = db.exec('PRAGMA table_info(cookies)')
    if (!ti.length) {
      db.close()
      return 0
    }
    const pcols = ti[0].columns as string[]
    const nIdx = pcols.indexOf('name')
    const tIdx = pcols.indexOf('type')
    const targetCols = (ti[0].values as unknown[][]).map((v) => String(v[nIdx]))
    const colIsInt: Record<string, boolean> = {}
    for (const v of ti[0].values as unknown[][]) {
      colIsInt[String(v[nIdx])] = String(v[tIdx]).toUpperCase().includes('INT')
    }
    const insSql = `INSERT OR REPLACE INTO cookies (${targetCols
      .map((c) => `"${c}"`)
      .join(',')}) VALUES (${targetCols.map((c) => '$' + c).join(',')})`

    let changed = 0
    db.exec('BEGIN')
    try {
      for (const r of cookies) {
        if (!r || !r.cols || !r.cols.host_key || !r.cols.name) continue
        const params: Record<string, unknown> = {}
        for (const c of targetCols) {
          if (c === 'value') params['$' + c] = r.value ?? ''
          else if (c === 'encrypted_value') params['$' + c] = new Uint8Array(0) // empty → plaintext
          else if (c in r.cols) params['$' + c] = r.cols[c]
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
    const tmp = ck + '.vgcnew'
    writeFileSync(tmp, outBytes)
    renameSync(tmp, ck)
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
