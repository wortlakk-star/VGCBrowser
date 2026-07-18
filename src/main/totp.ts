// ── TOTP (RFC 6238) — current 6-digit 2FA code from a base32 secret ───────────
// Pure Node crypto, NO deps and NO Electron/DOM imports (so it's unit-testable in
// isolation). Used by the bulk Gmail password changer to auto-fill Google
// Authenticator codes during the "verify it's you" 2-step challenge. The input is
// the 2FA SECRET KEY (e.g. "JBSW Y3DP EHPK 3PXP"), never a one-off 6-digit code.

import { createHmac } from 'node:crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode an RFC 4648 base32 secret. Google displays it space-separated and any
 *  case; we uppercase and drop every non-alphabet char (spaces, '=' padding). */
export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

export interface TotpOpts {
  digits?: number // default 6
  period?: number // seconds per step, default 30
  now?: number // ms epoch, default Date.now() — injectable for tests
}

/** Current TOTP code for a base32 secret (RFC 6238, HMAC-SHA1). Returns a
 *  zero-padded string of `digits` length. */
export function generateTotp(secret: string, opts: TotpOpts = {}): string {
  const digits = opts.digits ?? 6
  const period = opts.period ?? 30
  const now = opts.now ?? Date.now()
  const key = base32Decode(secret)
  if (key.length === 0) return ''

  let counter = Math.floor(now / 1000 / period)
  const buf = Buffer.alloc(8)
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff
    counter = Math.floor(counter / 256)
  }
  const hmac = createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return (bin % 10 ** digits).toString().padStart(digits, '0')
}

/** True if `secret` looks like a usable base32 2FA key (≥16 base32 chars → ≥80
 *  bits). Guards against the user pasting a 6-digit code by mistake. */
export function looksLikeTotpSecret(secret: string): boolean {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '')
  return clean.length >= 16
}
