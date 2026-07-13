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

import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'fs'
import { join, dirname } from 'path'
import type { SavedLogin } from '../shared/types'
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

function decryptV10(blob: Buffer, key: Buffer): string | null {
  try {
    if (blob.length <= 3 || !blob.subarray(0, 3).equals(V10)) return null
    const d = createDecipheriv('aes-128-cbc', key, FIXED_IV) // PKCS7 auto-unpad
    const out = Buffer.concat([d.update(blob.subarray(3)), d.final()])
    return out.toString('utf8')
  } catch {
    return null // wrong key / not our format → skip this row
  }
}

function encryptV10(plain: string, key: Buffer): Buffer {
  const c = createCipheriv('aes-128-cbc', key, FIXED_IV)
  return Buffer.concat([V10, c.update(Buffer.from(plain, 'utf8')), c.final()])
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
  const key = await localKey(id)
  if (!key) return []

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
        const plain = decryptV10(Buffer.from(pv), key)
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
  const key = await localKey(id)
  if (!key) return 0

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
        const pv = encryptV10(r.password, key)

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
              ? decryptV10(Buffer.from(existing.password_value), key) !== null
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
