// Per-account cloud encryption. Supabase stores only a passphrase-wrapped random
// account key; the passphrase itself is kept in OS secure storage on each device.

import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from 'crypto'
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { getCloudSession } from './session'
import { getSettings } from './settings'
import { requireSafeStorage } from './secure-store'

const WRAP_PREFIX = 'VGCWRAP1'
let cached: { uid: string; secret: string } | null = null

function remoteFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(20_000)
  })
}

async function boundedResponseText(res: Response, maxBytes = 64 * 1024): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('Phản hồi account secret vượt giới hạn')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('Phản hồi account secret vượt giới hạn')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function secretStorePath(uid: string): string {
  return join(app.getPath('userData'), `acct-secret-${uid}.bin`)
}

function passphraseStorePath(uid: string): string {
  return join(app.getPath('userData'), `cloud-passphrase-${uid}.bin`)
}

function encryptionMarkerPath(uid: string): string {
  return join(app.getPath('userData'), `enc-active-${uid}.flag`)
}

function secureWrite(filePath: string, value: string): void {
  requireSafeStorage()
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(temp, safeStorage.encryptString(value), { mode: 0o600, flag: 'wx' })
    renameSync(temp, filePath)
  } finally {
    rmSync(temp, { force: true })
  }
}

function secureRead(filePath: string): string | null {
  requireSafeStorage()
  let fd: number | undefined
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 64 * 1024) return null
    try {
      fchmodSync(fd, 0o600)
    } catch {
      // Windows ACLs are handled by DPAPI; chmod may be unavailable.
    }
    return safeStorage.decryptString(readFileSync(fd))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function persistSecret(uid: string, secret: string): void {
  secureWrite(secretStorePath(uid), secret)
}

function loadPersistedSecret(uid: string): string | null {
  return secureRead(secretStorePath(uid))
}

function loadPassphrase(uid: string): string | null {
  return secureRead(passphraseStorePath(uid))
}

function wrapSecret(uid: string, secret: string, passphrase: string): string {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('Khoá tài khoản không hợp lệ')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`vgc-account-secret:${uid}`, 'utf-8'))
  const encrypted = Buffer.concat([cipher.update(secret, 'utf-8'), cipher.final()])
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  return `${WRAP_PREFIX}:${salt.toString('base64')}:${payload}`
}

function unwrapSecret(uid: string, wrapped: string, passphrase: string): string | null {
  try {
    const [prefix, salt64, payload64] = wrapped.split(':')
    if (prefix !== WRAP_PREFIX || !salt64 || !payload64) return null
    if (
      salt64.length > 64 ||
      payload64.length > 512 ||
      !/^[a-z0-9+/]+={0,2}$/i.test(salt64) ||
      !/^[a-z0-9+/]+={0,2}$/i.test(payload64)
    ) {
      return null
    }
    const salt = Buffer.from(salt64, 'base64')
    const payload = Buffer.from(payload64, 'base64')
    if (salt.length !== 16 || payload.length !== 92) return null
    const key = scryptSync(passphrase, salt, 32)
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
    decipher.setAAD(Buffer.from(`vgc-account-secret:${uid}`, 'utf-8'))
    decipher.setAuthTag(payload.subarray(12, 28))
    const secret = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf-8')
    return /^[a-f0-9]{64}$/i.test(secret) ? secret : null
  } catch {
    return null
  }
}

type RemoteSecret =
  | { status: 'ok'; secret: string }
  | { status: 'empty' | 'missing' | 'error' }

async function remoteContext(): Promise<{
  base: string
  uid: string
  headers: Record<string, string>
} | null> {
  const session = getCloudSession()
  if (!session) return null
  const settings = await getSettings()
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) return null
  return {
    base: `${settings.supabaseUrl}/rest/v1/account_secrets`,
    uid: session.uid,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      apikey: settings.supabaseAnonKey,
      'Content-Type': 'application/json'
    }
  }
}

async function fetchRemoteSecret(
  context: NonNullable<Awaited<ReturnType<typeof remoteContext>>>
): Promise<RemoteSecret> {
  try {
    const res = await remoteFetch(
      `${context.base}?owner=eq.${encodeURIComponent(context.uid)}&select=secret`,
      { headers: context.headers }
    )
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      return { status: 'missing' }
    }
    if (!res.ok) {
      const detail = await boundedResponseText(res).catch(() => '')
      return detail.includes('does not exist') ? { status: 'missing' } : { status: 'error' }
    }
    const text = await boundedResponseText(res)
    const rows = JSON.parse(text) as Array<{ secret?: string }>
    const secret = rows[0]?.secret
    return typeof secret === 'string' && secret.length <= 4096
      ? { status: 'ok', secret }
      : { status: 'empty' }
  } catch {
    return { status: 'error' }
  }
}

async function updateRemoteSecret(
  context: NonNullable<Awaited<ReturnType<typeof remoteContext>>>,
  wrapped: string
): Promise<boolean> {
  try {
    const res = await remoteFetch(`${context.base}?owner=eq.${encodeURIComponent(context.uid)}`, {
      method: 'PATCH',
      headers: context.headers,
      body: JSON.stringify({ secret: wrapped })
    })
    await res.body?.cancel().catch(() => {})
    return res.ok
  } catch {
    return false
  }
}

async function insertRemoteSecret(
  context: NonNullable<Awaited<ReturnType<typeof remoteContext>>>,
  wrapped: string
): Promise<boolean> {
  try {
    const res = await remoteFetch(context.base, {
      method: 'POST',
      headers: { ...context.headers, Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({ owner: context.uid, secret: wrapped })
    })
    await res.body?.cancel().catch(() => {})
    return res.ok
  } catch {
    return false
  }
}

export function clearAccountSecretCache(): void {
  cached = null
}

export function cloudEncryptionStatus(): { configured: boolean; unlocked: boolean } {
  const session = getCloudSession()
  if (!session) return { configured: false, unlocked: false }
  const configured = Boolean(loadPassphrase(session.uid))
  const persisted = loadPersistedSecret(session.uid)
  // Accounts created before passphrase wrapping already have the stable account key in
  // OS secure storage. That key remains sufficient to decrypt this device's cloud data;
  // the passphrase is only required to unwrap the same key on a new device.
  const unlocked = Boolean(
    cached?.uid === session.uid || (persisted && /^[a-f0-9]{64}$/i.test(persisted))
  )
  return { configured, unlocked }
}

async function resolveAccountSecret(
  context: NonNullable<Awaited<ReturnType<typeof remoteContext>>>,
  passphrase: string,
  localSecret: string | null
): Promise<string | null> {
  const candidate =
    localSecret && /^[a-f0-9]{64}$/i.test(localSecret)
      ? localSecret
      : randomBytes(32).toString('hex')

  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await fetchRemoteSecret(context)
    if (remote.status === 'missing') return null
    if (remote.status === 'ok') {
      if (remote.secret.startsWith(`${WRAP_PREFIX}:`)) {
        return unwrapSecret(context.uid, remote.secret, passphrase)
      }
      if (!/^[a-f0-9]{64}$/i.test(remote.secret)) return null
      if (await updateRemoteSecret(context, wrapSecret(context.uid, remote.secret, passphrase))) {
        return remote.secret
      }
    } else if (remote.status === 'empty') {
      await insertRemoteSecret(context, wrapSecret(context.uid, candidate, passphrase))
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
  }
  return null
}

export async function setCloudEncryptionPassphrase(passphrase: string): Promise<void> {
  const session = getCloudSession()
  if (!session) throw new Error('Chưa đăng nhập cloud.')
  const normalized = passphrase.normalize('NFKC')
  if (normalized.length < 12) throw new Error('Passphrase cloud phải có ít nhất 12 ký tự.')
  if (normalized.length > 1024) throw new Error('Passphrase cloud quá dài.')
  const context = await remoteContext()
  if (!context || context.uid !== session.uid) throw new Error('Phiên cloud không hợp lệ.')
  const secret = await resolveAccountSecret(context, normalized, loadPersistedSecret(session.uid))
  if (!secret) {
    throw new Error('Không mở hoặc di chuyển được khoá cloud. Kiểm tra passphrase và migration SQL.')
  }
  // Persist only after the candidate passphrase has authenticated the remote wrapper.
  // A typo therefore cannot overwrite a working local passphrase.
  secureWrite(passphraseStorePath(session.uid), normalized)
  persistSecret(session.uid, secret)
  cached = { uid: session.uid, secret }
}

export function isEncryptionActive(): boolean {
  const session = getCloudSession()
  if (!session) return false
  const persisted = loadPersistedSecret(session.uid)
  return Boolean(
    loadPassphrase(session.uid) ||
      (persisted && /^[a-f0-9]{64}$/i.test(persisted)) ||
      secureMarkerExists(encryptionMarkerPath(session.uid))
  )
}

function secureMarkerExists(filePath: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    return stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 64
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Fetch or create the random account key. Legacy plaintext server keys are
 * migrated in-place to passphrase-wrapped VGCWRAP1 values before use. */
export async function getAccountSecret(): Promise<string | null> {
  const context = await remoteContext()
  if (!context) return null
  if (cached?.uid === context.uid) return cached.secret
  // Legacy installations stored the stable random key directly in Keychain/DPAPI and
  // have no cloud-passphrase file. Trust that OS-protected copy: refusing it makes every
  // previously encrypted profile look like it has a wrong passphrase after an update.
  const local = loadPersistedSecret(context.uid)
  if (local && /^[a-f0-9]{64}$/i.test(local)) {
    cached = { uid: context.uid, secret: local }
    return local
  }
  const passphrase = loadPassphrase(context.uid)
  if (!passphrase) return null
  const secret = await resolveAccountSecret(context, passphrase, local)
  if (!secret) return null
  persistSecret(context.uid, secret)
  cached = { uid: context.uid, secret }
  return secret
}

function keyFor(secret: string, context: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(secret) || !/^[a-z0-9:_-]{1,128}$/i.test(context)) {
    throw new Error('Ngữ cảnh mã hoá cloud không hợp lệ')
  }
  return createHash('sha256').update(`${secret}:${context}`).digest()
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
    if (blob.length < 40 || blob.length > 32 * 1024 * 1024 || !/^[a-z0-9+/]+={0,2}$/i.test(blob)) {
      return null
    }
    const buf = Buffer.from(blob, 'base64')
    if (buf.length < 29) return null
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, context), buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const ENC_MAGIC = Buffer.from('VGCENC1\0', 'latin1')

export function encryptBytes(secret: string, context: string, data: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, context), iv)
  const enc = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([ENC_MAGIC, iv, cipher.getAuthTag(), enc])
}

export function isEncryptedBytes(buf: Buffer): boolean {
  return buf.length >= ENC_MAGIC.length && buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)
}

export function decryptBytes(secret: string, context: string, buf: Buffer): Buffer | null {
  try {
    if (!isEncryptedBytes(buf) || buf.length < ENC_MAGIC.length + 29) return null
    const body = buf.subarray(ENC_MAGIC.length)
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, context), body.subarray(0, 12))
    decipher.setAuthTag(body.subarray(12, 28))
    return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()])
  } catch {
    return null
  }
}
