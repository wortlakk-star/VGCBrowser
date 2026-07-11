// ── VGC Browser — per-account encryption secret ──────────────────────────────
// A random 32-byte secret generated ONCE per cloud account and stored in Supabase
// (table `account_secrets`, RLS: only the owner can read it when signed in). It is
// the real secret behind:
//   • the portable os_crypt key (so the engine key is NOT derivable from the public
//     uid/profileId — only someone who can log in as the account can get it), and
//   • app-side AES-256-GCM encryption of the synced cookies JSON before it leaves
//     the machine (so a leaked bucket/DB shows ciphertext, not live sessions).
//
// Fetched from main via the Supabase REST API using the renderer-provided access
// token (same pattern as cloud-data.ts). Cached in memory per uid. If the table
// isn't migrated yet (supabase/account-secrets.sql not run), getAccountSecret()
// returns null and callers fall back to the older (weaker) behavior so nothing
// breaks during rollout.

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { getCloudSession } from './session'
import { getSettings } from './settings'

let cached: { uid: string; secret: string } | null = null
// True once we've obtained a secret for the signed-in account this session.
let encryptionActive = false

// PERSISTENT, OS-encrypted copy of the account secret (macOS Keychain / Windows DPAPI
// via Electron safeStorage). The secret is generated ONCE per account and never rotates,
// so caching it on disk is safe — and CRITICAL: it means a network blip, an app restart,
// or a brief sign-out can NEVER make getAccountSecret() return null (→ a DIFFERENT
// os_crypt key → the profile's Cookies/Login Data become undecryptable = silent logout +
// lost saved passwords). Once fetched on a machine, the SAME key is always available.
function secretStorePath(uid: string): string {
  return join(app.getPath('userData'), `acct-secret-${uid}.bin`)
}
function persistSecret(uid: string, secret: string): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) return
    writeFileSync(secretStorePath(uid), safeStorage.encryptString(secret))
  } catch {
    // best-effort — the in-memory cache still holds it for this session
  }
}
function loadPersistedSecret(uid: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const p = secretStorePath(uid)
    if (!existsSync(p)) return null
    return safeStorage.decryptString(readFileSync(p))
  } catch {
    return null
  }
}

// A PERSISTENT marker (per account uid) written the first time encryption succeeds.
// Without it, the guard only covered mid-session uploads: the very FIRST upload of a
// fresh process — before any getAccountSecret() has run — could still go plaintext on
// a transient failure and overwrite the encrypted cloud copy. The marker makes the
// guard survive restarts, so once an account is encrypted it can NEVER downgrade.
function encMarkerPath(uid: string): string {
  return join(app.getPath('userData'), `enc-active-${uid}.flag`)
}
function markEncryptionActive(uid: string): void {
  encryptionActive = true
  try {
    writeFileSync(encMarkerPath(uid), '1')
  } catch {
    // best-effort; the in-memory flag still guards this session
  }
}

export function clearAccountSecretCache(): void {
  cached = null
  encryptionActive = false
}

/** True once encryption has EVER been confirmed active for the signed-in account
 *  (this session OR a persisted marker from a prior run). Callers use this to REFUSE
 *  plaintext uploads on a transient key-fetch failure. */
export function isEncryptionActive(): boolean {
  if (encryptionActive) return true
  const s = getCloudSession()
  return s ? existsSync(encMarkerPath(s.uid)) : false
}

/** Fetch (or create on first use) the account secret. null if signed out or the
 *  table isn't available yet. */
export async function getAccountSecret(): Promise<string | null> {
  const session = getCloudSession()
  if (!session) return null
  if (cached && cached.uid === session.uid) return cached.secret

  // Persisted OS-encrypted copy → same STABLE key across restarts / offline / network
  // blips. The secret never rotates, so this is authoritative once fetched on this
  // machine; no need to hit the network again (which is exactly what used to fail and
  // flip the key to a divergent fallback).
  const persisted = loadPersistedSecret(session.uid)
  if (persisted) {
    cached = { uid: session.uid, secret: persisted }
    markEncryptionActive(session.uid)
    return persisted
  }

  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return null
  const base = `${s.supabaseUrl}/rest/v1/account_secrets`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    apikey: s.supabaseAnonKey,
    'Content-Type': 'application/json'
  }
  type Res =
    | { status: 'ok'; secret: string }
    | { status: 'empty' }
    | { status: 'nomigration' }
    | { status: 'error' }
  const fetchExisting = async (): Promise<Res> => {
    try {
      const r = await fetch(`${base}?owner=eq.${session.uid}&select=secret`, { headers })
      if (r.status === 404) return { status: 'nomigration' }
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        return t.includes('does not exist') ? { status: 'nomigration' } : { status: 'error' }
      }
      const rows = (await r.json()) as Array<{ secret?: string }>
      return rows.length && rows[0].secret
        ? { status: 'ok', secret: rows[0].secret }
        : { status: 'empty' }
    } catch {
      return { status: 'error' }
    }
  }

  // Retry transient errors so a network blip doesn't drop the key (→ plaintext
  // upload / "lost session"). Only 'nomigration' returns null (real fallback).
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchExisting()
    if (res.status === 'ok') {
      cached = { uid: session.uid, secret: res.secret }
      markEncryptionActive(session.uid)
      persistSecret(session.uid, res.secret)
      return res.secret
    }
    if (res.status === 'nomigration') return null
    if (res.status === 'empty') {
      const secret = randomBytes(32).toString('hex')
      try {
        const ins = await fetch(base, {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify({ owner: session.uid, secret })
        })
        if (ins.ok) {
          const after = await fetchExisting() // another device may have won the race
          const finalSecret = after.status === 'ok' ? after.secret : secret
          cached = { uid: session.uid, secret: finalSecret }
          markEncryptionActive(session.uid)
          persistSecret(session.uid, finalSecret)
          return finalSecret
        }
      } catch {
        // fall through to retry
      }
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  return null // transient failures exhausted → caller refuses plaintext via isEncryptionActive()
}

function keyFor(secret: string, context: string): Buffer {
  return createHash('sha256').update(`${secret}:${context}`).digest() // 32 bytes
}

/** AES-256-GCM. Output = base64(iv[12] | tag[16] | ciphertext). */
export function encryptWithSecret(secret: string, context: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, context), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

export function decryptWithSecret(secret: string, context: string, blob: string): string | null {
  try {
    const buf = Buffer.from(blob, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, context), buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

// Binary variants for large blobs (the session zip) — avoids base64's 33% bloat.
// Layout: iv[12] | tag[16] | ciphertext. Magic prefix lets the reader tell an
// encrypted object from a raw (legacy/plaintext) zip, which always starts with "PK".
export const ENC_MAGIC = Buffer.from('VGCENC1\0', 'latin1') // 8 bytes

export function encryptBytes(secret: string, context: string, data: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, context), iv)
  const enc = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([ENC_MAGIC, iv, cipher.getAuthTag(), enc])
}

/** True if a downloaded object is one of our encrypted blobs (vs a raw zip). */
export function isEncryptedBytes(buf: Buffer): boolean {
  return buf.length >= ENC_MAGIC.length && buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)
}

export function decryptBytes(secret: string, context: string, buf: Buffer): Buffer | null {
  try {
    const body = buf.subarray(ENC_MAGIC.length)
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, context), body.subarray(0, 12))
    decipher.setAuthTag(body.subarray(12, 28))
    return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()])
  } catch {
    return null
  }
}
