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
// crash, never data loss). Writes go through a .vgcbak backup + PRAGMA integrity_check;
// any anomaly restores the backup. better-sqlite3 is loaded lazily so a missing/broken
// native binding just disables the bridge instead of breaking a launch.

import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, copyFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { SavedLogin } from '../shared/types'
import { getAccountSecret } from './account-secret'
import { getSettings } from './settings'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

let sqliteLoaded = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SqliteCtor: any = null
function loadSqlite(): unknown {
  if (sqliteLoaded) return SqliteCtor
  sqliteLoaded = true
  try {
    // Lazy CJS require (electron-vite externalises deps): a broken/missing native
    // binding disables the bridge rather than throwing at module load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    SqliteCtor = require('better-sqlite3')
  } catch (e) {
    console.error('[vgc-pw] better-sqlite3 unavailable — password bridge disabled:', e)
    SqliteCtor = null
  }
  return SqliteCtor
}

const V10 = Buffer.from('v10', 'latin1')
const FIXED_IV = Buffer.alloc(16, 0x20) // 16 spaces — the os_crypt v10 AES-128-CBC IV

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
      // System Google Chrome → the "Chrome Safe Storage" keychain password.
      let pw = ''
      for (const acctName of ['Chrome', 'Google Chrome']) {
        try {
          pw = execFileSync(
            'security',
            ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', acctName],
            { encoding: 'utf8', timeout: 5000 }
          ).trim()
          if (pw) break
        } catch {
          /* try next account name */
        }
      }
      if (!pw) {
        try {
          pw = execFileSync(
            'security',
            ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
            { encoding: 'utf8', timeout: 5000 }
          ).trim()
        } catch {
          return null
        }
      }
      if (!pw) return null
      return pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1')
    }
    return null // Linux: system Chrome/basic-text varies — bridge off for now.
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

function tmpCopy(src: string, tag: string): string {
  const dst = join(app.getPath('temp'), `vgc-pw-${tag}-${process.pid}-${Date.now()}.db`)
  copyFileSync(src, dst)
  return dst
}
function safeRm(p: string): void {
  try {
    rmSync(p, { force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * Read + DECRYPT the profile's saved logins with the LOCAL key. Returns [] on any
 * problem (no engine, no key, no DB, native module missing). Reads a COPY so it never
 * touches the live file.
 */
export async function exportLogins(userDataDir: string, id: string): Promise<SavedLogin[]> {
  const Sqlite = loadSqlite() as (new (p: string, o?: unknown) => Db) | null
  if (!Sqlite) return []
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) return []
  const key = await localKey(id)
  if (!key) return []

  let copy = ''
  let db: Db | null = null
  try {
    copy = tmpCopy(ld, 'rd')
    db = new Sqlite(copy, { readonly: true, fileMustExist: true })
    const rows = db
      .prepare(
        `SELECT origin_url, action_url, username_element, username_value,
                password_element, password_value, signon_realm, scheme,
                date_created, date_password_modified, times_used, blacklisted_by_user
         FROM logins`
      )
      .all() as Array<Record<string, unknown>>
    const out: SavedLogin[] = []
    for (const r of rows) {
      const pv = r.password_value as Buffer | null
      if (!pv || !pv.length) continue // blacklist "never save" rows have no password
      const plain = decryptV10(Buffer.from(pv), key)
      if (plain == null || plain === '') continue // couldn't decrypt / empty → skip
      out.push({
        origin_url: String(r.origin_url ?? ''),
        signon_realm: String(r.signon_realm ?? ''),
        password: plain,
        action_url: (r.action_url as string) ?? '',
        username_element: (r.username_element as string) ?? '',
        username_value: (r.username_value as string) ?? '',
        password_element: (r.password_element as string) ?? '',
        scheme: Number(r.scheme ?? 0),
        date_created: Number(r.date_created ?? 0),
        date_password_modified: Number(r.date_password_modified ?? 0),
        times_used: Number(r.times_used ?? 0),
        blacklisted_by_user: Number(r.blacklisted_by_user ?? 0)
      })
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
    if (copy) safeRm(copy)
  }
}

/**
 * MERGE cloud logins into the profile's Login Data, RE-ENCRYPTING each with the LOCAL
 * key. Adds new logins (by origin/username/realm) and updates a password only when the
 * incoming copy is NEWER. Never deletes. Fail-safe: backs up + integrity-checks and
 * restores on any anomaly. Returns how many rows were added/updated (0 on skip/error).
 */
export async function importLogins(
  userDataDir: string,
  id: string,
  logins: SavedLogin[]
): Promise<number> {
  if (!logins?.length) return 0
  const Sqlite = loadSqlite() as (new (p: string, o?: unknown) => Db) | null
  if (!Sqlite) return 0
  const ld = loginDataPath(userDataDir)
  if (!existsSync(ld)) return 0 // no schema to merge into (engine makes it on first run)
  const key = await localKey(id)
  if (!key) return 0

  const bak = ld + '.vgcbak'
  let db: Db | null = null
  try {
    copyFileSync(ld, bak)
    db = new Sqlite(ld, { fileMustExist: true })

    const cols = new Set(
      (db.prepare('PRAGMA table_info(logins)').all() as Array<{ name: string }>).map((c) => c.name)
    )
    // Only write columns that exist in THIS engine's schema (macOS system Chrome may be
    // a different version) — the rest fall back to their SQLite defaults.
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

    const findStmt = db.prepare(
      `SELECT id, date_password_modified FROM logins
       WHERE origin_url=? AND username_element=? AND username_value=?
         AND password_element=? AND signon_realm=?`
    )
    const insStmt = db.prepare(
      `INSERT OR IGNORE INTO logins (${wanted.join(',')})
       VALUES (${wanted.map(() => '?').join(',')})`
    )
    const updStmt = db.prepare(
      'UPDATE logins SET password_value=?, date_password_modified=? WHERE id=?'
    )

    let changed = 0
    const tx = db.transaction((recs: SavedLogin[]) => {
      for (const r of recs) {
        if (!r.origin_url || !r.signon_realm || !r.password) continue
        const ue = r.username_element ?? ''
        const pe = r.password_element ?? ''
        const uv = r.username_value ?? ''
        const pv = encryptV10(r.password, key)
        const existing = findStmt.get(r.origin_url, ue, uv, pe, r.signon_realm) as
          | { id: number; date_password_modified: number }
          | undefined
        if (existing) {
          if ((r.date_password_modified ?? 0) > (existing.date_password_modified ?? 0)) {
            updStmt.run(pv, r.date_password_modified ?? 0, existing.id)
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
          const info = insStmt.run(...wanted.map((c) => val[c]))
          if (info.changes > 0) changed++
        }
      }
    })
    tx(logins)

    const integ = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    db.close()
    db = null
    if (integ?.integrity_check !== 'ok') {
      // Corruption after write → roll back to the backup, drop everything we did.
      copyFileSync(bak, ld)
      console.error('[vgc-pw] integrity_check failed after merge — restored backup')
      return 0
    }
    safeRm(bak)
    return changed
  } catch (e) {
    console.error('[vgc-pw] importLogins failed — restoring backup:', e)
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(bak)) {
        // Only restore if the backup is a sane size (never clobber with an empty file).
        if (statSync(bak).size > 0) copyFileSync(bak, ld)
      }
    } catch {
      /* best-effort */
    }
    safeRm(bak)
    return 0
  }
}
