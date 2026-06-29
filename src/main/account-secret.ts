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
import { getCloudSession } from './session'
import { getSettings } from './settings'

let cached: { uid: string; secret: string } | null = null

export function clearAccountSecretCache(): void {
  cached = null
}

/** Fetch (or create on first use) the account secret. null if signed out or the
 *  table isn't available yet. */
export async function getAccountSecret(): Promise<string | null> {
  const session = getCloudSession()
  if (!session) return null
  if (cached && cached.uid === session.uid) return cached.secret

  const s = await getSettings()
  if (!s.supabaseUrl || !s.supabaseAnonKey) return null
  const base = `${s.supabaseUrl}/rest/v1/account_secrets`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    apikey: s.supabaseAnonKey,
    'Content-Type': 'application/json'
  }
  const fetchExisting = async (): Promise<string | null> => {
    const r = await fetch(`${base}?owner=eq.${session.uid}&select=secret`, { headers })
    if (!r.ok) return null
    const rows = (await r.json()) as Array<{ secret?: string }>
    return rows.length && rows[0].secret ? rows[0].secret : null
  }

  try {
    const existing = await fetchExisting()
    if (existing) {
      cached = { uid: session.uid, secret: existing }
      return existing
    }
    // None yet → create one. ignore-duplicates handles two devices racing.
    const secret = randomBytes(32).toString('hex')
    const ins = await fetch(base, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({ owner: session.uid, secret })
    })
    if (ins.ok) {
      // Re-read in case another device's row won the insert race.
      const after = (await fetchExisting()) ?? secret
      cached = { uid: session.uid, secret: after }
      return after
    }
    return null
  } catch {
    return null
  }
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
