// ── VGC Browser — kho passkey phần mềm riêng cho từng profile ─────────────────
// Máy chủ Windows/Mac không có "thiết bị passkey" (Windows Hello, điện thoại, USB) gắn riêng cho
// từng profile. Module này đóng vai một authenticator phần mềm (kiểu Bitwarden/1Password):
//   • sinh khoá ES256 (P-256), ký bằng node:crypto — khoá riêng KHÔNG bao giờ rời tiến trình chính;
//   • extension "VGC Passkeys" (passkey-ext.ts) chỉ là lớp mỏng nối trang web với các hàm dưới đây
//     qua máy chủ 127.0.0.1 (token riêng mỗi lần mở profile, xem lock-ext.ts);
//   • kho nằm trong `<profile>/Default/vgc-passkeys.enc` — vì cloud chỉ nén Default/ nên passkey
//     TỰ ĐỒNG BỘ theo profile (đã mã hoá đầu-cuối bằng khoá tài khoản) sang máy khác;
//   • file được mã hoá AES-256-GCM bằng khoá tài khoản (account-secret) và ghi nguyên tử.
// Giới hạn có chủ đích: chỉ ES256, attestation "none", không PRF/largeBlob, không hybrid/QR.

import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'crypto'
import { decryptBytes, encryptBytes, getAccountSecret, isEncryptedBytes } from './account-secret'
import { requireProfileId } from './validation'

export interface PkCred {
  id: string // credentialId, base64url
  rpId: string
  userHandle: string // base64url
  userName: string
  displayName: string
  pkcs8: string // khoá riêng, DER PKCS8 base64
  spki: string // khoá công khai, DER SPKI base64
  created: string
  lastUsed?: string
}
interface PkFile {
  v: 1
  creds: PkCred[]
}
export interface PasskeyInfo {
  id: string
  rpId: string
  userName: string
  displayName: string
  created: string
  lastUsed?: string
}

/** Lỗi mang tên DOMException để extension ném lại đúng loại cho trang web. */
export class PkError extends Error {
  constructor(
    readonly domName: 'NotAllowedError' | 'InvalidStateError' | 'NotSupportedError' | 'SecurityError' | 'UnknownError',
    message: string
  ) {
    super(message)
  }
}

const b64u = (b: Buffer): string => b.toString('base64url')
const fromB64u = (s: string): Buffer => Buffer.from(String(s ?? ''), 'base64url')

// ── CBOR tối thiểu (chỉ phần WebAuthn cần) ───────────────────────────────────
type Cbor = number | string | Buffer | Map<number | string, Cbor>
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  if (n < 65536) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}
export function cborEncode(v: Cbor): Buffer {
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v])
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8')
    return Buffer.concat([cborHead(3, s.length), s])
  }
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v)
  const parts: Buffer[] = [cborHead(5, v.size)]
  for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val))
  return Buffer.concat(parts)
}

// ── Kho trên đĩa ─────────────────────────────────────────────────────────────
function storeFile(profileId: string): string {
  return join(app.getPath('userData'), 'profiles', requireProfileId(profileId), 'Default', 'vgc-passkeys.enc')
}
const context = (profileId: string): string => `pk:${profileId}`

let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function secretOrThrow(): Promise<string> {
  const s = await getAccountSecret()
  if (!s) throw new PkError('NotAllowedError', 'Chưa mở khoá mã hoá cloud — chưa dùng được kho passkey.')
  return s
}

/** Đọc kho. File chưa có → rỗng. File có mà KHÔNG giải mã được → ném lỗi (không bao giờ ghi đè). */
async function readStore(profileId: string, secret: string): Promise<PkFile> {
  let raw: Buffer
  try {
    raw = await readFile(storeFile(profileId))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, creds: [] }
    throw new PkError('UnknownError', 'Không đọc được kho passkey.')
  }
  if (!isEncryptedBytes(raw)) throw new PkError('UnknownError', 'Kho passkey không đúng định dạng.')
  const plain = decryptBytes(secret, context(profileId), raw)
  if (!plain) throw new PkError('UnknownError', 'Không giải mã được kho passkey (sai khoá mã hoá cloud?).')
  try {
    const parsed = JSON.parse(plain.toString('utf8')) as PkFile
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.creds)) throw new Error('bad')
    return parsed
  } catch {
    throw new PkError('UnknownError', 'Kho passkey bị hỏng.')
  }
}

async function writeStore(profileId: string, secret: string, data: PkFile): Promise<void> {
  const file = storeFile(profileId)
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, encryptBytes(secret, context(profileId), Buffer.from(JSON.stringify(data), 'utf8')), {
      mode: 0o600
    })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

// ── Kiểm tra nguồn gốc / rpId ────────────────────────────────────────────────
function resolveRpId(origin: string, requested: string | undefined): { rpId: string; origin: string } {
  let url: URL
  try {
    url = new URL(String(origin))
  } catch {
    throw new PkError('SecurityError', 'Nguồn gốc không hợp lệ.')
  }
  const host = url.hostname.toLowerCase()
  const secure = url.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1'
  if (!secure) throw new PkError('SecurityError', 'Passkey chỉ dùng trên trang HTTPS.')
  const rpId = (requested ? String(requested) : host).toLowerCase()
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
  const ok = rpId === host || (!isIp && rpId.includes('.') && host.endsWith('.' + rpId))
  if (!ok) throw new PkError('SecurityError', 'rpId không hợp lệ cho trang này.')
  return { rpId, origin: url.origin }
}

const rpIdHash = (rpId: string): Buffer => createHash('sha256').update(rpId, 'utf8').digest()

// ── Tạo passkey (navigator.credentials.create) ───────────────────────────────
export interface PkCreateReq {
  origin: string
  rpId?: string
  challenge: string // base64url
  user: { id: string; name: string; displayName: string } // id: base64url
  excludeIds?: string[]
  algs?: number[]
}
export interface PkCreateRes {
  id: string
  clientDataJSON: string
  attestationObject: string
  authData: string
  publicKey: string // SPKI DER, base64url
  alg: -7
}

export function pkCreate(profileId: string, req: PkCreateReq): Promise<PkCreateRes> {
  return serialize(async () => {
    const { rpId, origin } = resolveRpId(req.origin, req.rpId)
    if (Array.isArray(req.algs) && req.algs.length > 0 && !req.algs.includes(-7)) {
      throw new PkError('NotSupportedError', 'Chỉ hỗ trợ thuật toán ES256.')
    }
    const userHandle = fromB64u(req.user?.id)
    if (userHandle.length < 1 || userHandle.length > 64) throw new PkError('NotAllowedError', 'user.id không hợp lệ.')
    const secret = await secretOrThrow()
    const store = await readStore(profileId, secret)

    const exclude = new Set((req.excludeIds ?? []).map(String))
    if (store.creds.some((c) => c.rpId === rpId && exclude.has(c.id))) {
      throw new PkError('InvalidStateError', 'Passkey này đã có trong profile.')
    }

    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    const credId = randomBytes(32)
    const cose = cborEncode(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64u(jwk.x)],
        [-3, fromB64u(jwk.y)]
      ])
    )
    // Cờ: UP | UV | BE | BS | AT — giống passkey đồng bộ (đa thiết bị, đã sao lưu).
    const flags = 0x01 | 0x04 | 0x08 | 0x10 | 0x40
    const idLen = Buffer.alloc(2)
    idLen.writeUInt16BE(credId.length)
    const authData = Buffer.concat([
      rpIdHash(rpId),
      Buffer.from([flags]),
      Buffer.alloc(4), // signCount = 0 (passkey đồng bộ không đếm)
      Buffer.alloc(16), // AAGUID = 0 (attestation "none")
      idLen,
      credId,
      cose
    ])
    const attestationObject = cborEncode(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData]
      ])
    )
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: req.challenge, origin, crossOrigin: false }),
      'utf8'
    )

    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    const cred: PkCred = {
      id: b64u(credId),
      rpId,
      userHandle: b64u(userHandle),
      userName: String(req.user?.name ?? '').slice(0, 256),
      displayName: String(req.user?.displayName ?? '').slice(0, 256),
      pkcs8: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
      spki: spki.toString('base64'),
      created: new Date().toISOString()
    }
    // Cùng (rpId, user) → thay thế passkey cũ (đúng chuẩn discoverable credential).
    store.creds = store.creds.filter((c) => !(c.rpId === rpId && c.userHandle === cred.userHandle))
    store.creds.push(cred)
    await writeStore(profileId, secret, store)

    return {
      id: cred.id,
      clientDataJSON: b64u(clientDataJSON),
      attestationObject: b64u(attestationObject),
      authData: b64u(authData),
      publicKey: b64u(spki),
      alg: -7
    }
  })
}

// ── Đăng nhập bằng passkey (navigator.credentials.get) ───────────────────────
export interface PkGetReq {
  origin: string
  rpId?: string
  challenge: string // base64url
  allowIds?: string[]
}
export interface PkGetRes {
  id: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle: string
}

function candidates(store: PkFile, rpId: string, allowIds?: string[]): PkCred[] {
  const allow = allowIds && allowIds.length ? new Set(allowIds.map(String)) : null
  return store.creds
    .filter((c) => c.rpId === rpId && (!allow || allow.has(c.id)))
    .sort((a, b) => (b.lastUsed ?? b.created).localeCompare(a.lastUsed ?? a.created))
}

/** Có passkey phù hợp không (dùng cho conditional mediation, không ký gì). */
export function pkHas(profileId: string, req: { origin: string; rpId?: string; allowIds?: string[] }): Promise<boolean> {
  return serialize(async () => {
    const { rpId } = resolveRpId(req.origin, req.rpId)
    const secret = await getAccountSecret()
    if (!secret) return false
    return candidates(await readStore(profileId, secret), rpId, req.allowIds).length > 0
  })
}

export function pkGet(profileId: string, req: PkGetReq): Promise<PkGetRes> {
  return serialize(async () => {
    const { rpId, origin } = resolveRpId(req.origin, req.rpId)
    const secret = await secretOrThrow()
    const store = await readStore(profileId, secret)
    const cred = candidates(store, rpId, req.allowIds)[0]
    if (!cred) throw new PkError('NotAllowedError', 'Không có passkey nào cho trang này trong profile.')

    const flags = 0x01 | 0x04 | 0x08 | 0x10 // UP | UV | BE | BS
    const authData = Buffer.concat([rpIdHash(rpId), Buffer.from([flags]), Buffer.alloc(4)])
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: req.challenge, origin, crossOrigin: false }),
      'utf8'
    )
    const clientHash = createHash('sha256').update(clientDataJSON).digest()
    const key = createPrivateKey({ key: Buffer.from(cred.pkcs8, 'base64'), format: 'der', type: 'pkcs8' })
    const signature = sign('sha256', Buffer.concat([authData, clientHash]), { key, dsaEncoding: 'der' })

    cred.lastUsed = new Date().toISOString()
    await writeStore(profileId, secret, store)

    return {
      id: cred.id,
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
      userHandle: cred.userHandle
    }
  })
}

// ── Quản lý trong giao diện ──────────────────────────────────────────────────
export function listPasskeys(profileId: string): Promise<PasskeyInfo[]> {
  return serialize(async () => {
    const secret = await getAccountSecret()
    if (!secret) return []
    try {
      const store = await readStore(profileId, secret)
      return store.creds
        .map((c) => ({
          id: c.id,
          rpId: c.rpId,
          userName: c.userName,
          displayName: c.displayName,
          created: c.created,
          lastUsed: c.lastUsed
        }))
        .sort((a, b) => a.rpId.localeCompare(b.rpId))
    } catch {
      return []
    }
  })
}

export function deletePasskey(profileId: string, credId: string): Promise<boolean> {
  return serialize(async () => {
    const secret = await secretOrThrow()
    const store = await readStore(profileId, secret)
    const before = store.creds.length
    store.creds = store.creds.filter((c) => c.id !== String(credId))
    if (store.creds.length === before) return false
    await writeStore(profileId, secret, store)
    return true
  })
}

/** Dùng cho test: public key dạng KeyObject từ SPKI đã lưu. */
export function spkiToPublicKey(spkiB64: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' })
}
