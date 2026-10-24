// ── VGC Browser — đồng bộ cấu hình KHOÁ theo tài khoản (cloud) ──────────────────
// Trước đây khoá chỉ nằm trên từng máy: bật khoá ở máy này, đăng nhập máy khác lại thấy hết, không
// ẩn, không khoá. Giờ cấu hình khoá đi theo tài khoản:
//   Storage `<uid>/00000000-0000-4000-8000-677561726430.cookiesdb.json` = cấu hình khoá mã hoá bằng khoá
//   tài khoản (AES-256-GCM, context `guardcfg:<uid>`). Gồm: mật khẩu chủ + SOS (chỉ MÃ BĂM scrypt),
//   profile nào khoá, nhóm nào khoá (mã băm), các giới hạn, thời gian tự khoá. KHÔNG gồm bộ đếm sai —
//   mỗi máy tự đếm.
// Tên tệp phải khớp chính sách RLS của bucket `profiles` (xem passkey-vault.ts) nên dùng một "mã profile"
// cố định (677561726430 = "guard0").
//
// Quy tắc đồng bộ — bản có `rev` (thời điểm sửa) MỚI HƠN thắng:
//   • cloud chưa có + máy này có cấu hình  → đẩy lên;
//   • cloud mới hơn                         → nhận về (máy có cấu hình cũ chưa đồng bộ thì GỘP khoá, không mất);
//   • máy này mới hơn                       → đẩy lên.
// Lỗi mạng / giải mã / chưa đăng nhập KHÔNG BAO GIỜ ghi đè hay nhận bậy.
//
// Khi nào chạy: đăng nhập tài khoản (cloud:setSession CHỜ xong rồi mới cho giao diện hiện danh sách,
// nên không có cảnh "hiện hết rồi mới ẩn"), mỗi thay đổi khoá (sau ~2 giây), mỗi 15 phút.

import { decryptBytes, encryptBytes, getAccountSecret, isEncryptedBytes } from './account-secret'
import { accountObject } from './cloud-data'
import { dbg } from './dbg'
import {
  applyRemoteGuard,
  guardEnsureRev,
  guardSyncSnapshot,
  setGuardChangeListener,
  type GuardSyncData
} from './guard'
import { getCloudSession } from './session'

const OBJECT = '00000000-0000-4000-8000-677561726430.cookiesdb.json'
const ctx = (uid: string): string => `guardcfg:${uid}`

export interface GuardSyncResult {
  ok: boolean
  action?: 'none' | 'pushed' | 'adopted'
  error?: string
}

let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function validRemote(d: unknown): d is GuardSyncData {
  const x = d as GuardSyncData
  return (
    !!x &&
    x.v === 1 &&
    Number.isFinite(x.rev) &&
    x.rev >= 0 &&
    !!x.profiles &&
    typeof x.profiles === 'object' &&
    !!x.groups &&
    typeof x.groups === 'object'
  )
}

async function fetchRemote(secret: string, uid: string): Promise<{ data: GuardSyncData | null } | null> {
  const r = await accountObject('get', OBJECT)
  if (!r.ok) return null
  if (!r.data) return { data: null }
  if (!isEncryptedBytes(r.data)) return null
  const plain = decryptBytes(secret, ctx(uid), r.data)
  if (!plain) return null
  try {
    const parsed = JSON.parse(plain.toString('utf8'))
    return validRemote(parsed) ? { data: parsed } : null
  } catch {
    return null
  }
}

async function push(secret: string, uid: string, data: GuardSyncData): Promise<boolean> {
  const bytes = encryptBytes(secret, ctx(uid), Buffer.from(JSON.stringify(data), 'utf8'))
  return (await accountObject('put', OBJECT, bytes)).ok
}

async function doSync(): Promise<GuardSyncResult> {
  const session = getCloudSession()
  if (!session) return { ok: false, error: 'Chưa đăng nhập cloud.' }
  const secret = await getAccountSecret()
  if (!secret) return { ok: false, error: 'Chưa mở khoá mã hoá cloud.' }
  const remote = await fetchRemote(secret, session.uid)
  if (!remote) return { ok: false, error: 'Không đọc được cấu hình khoá trên cloud (mạng hoặc khoá mã hoá).' }

  let snap = await guardSyncSnapshot()
  if (!remote.data) {
    if (!snap.hasConfig) return { ok: true, action: 'none' }
    if (snap.data.rev === 0) {
      await guardEnsureRev()
      snap = await guardSyncSnapshot()
    }
    return (await push(secret, session.uid, snap.data))
      ? { ok: true, action: 'pushed' }
      : { ok: false, error: 'Không ghi được cấu hình khoá lên cloud.' }
  }

  if (remote.data.rev > snap.data.rev) {
    const union = snap.data.rev === 0 && snap.hasConfig
    await applyRemoteGuard(remote.data, union)
    if (union) {
      snap = await guardSyncSnapshot()
      if (!(await push(secret, session.uid, snap.data))) return { ok: false, error: 'Không ghi được cấu hình khoá lên cloud.' }
      return { ok: true, action: 'pushed' }
    }
    return { ok: true, action: 'adopted' }
  }
  if (snap.data.rev > remote.data.rev) {
    return (await push(secret, session.uid, snap.data))
      ? { ok: true, action: 'pushed' }
      : { ok: false, error: 'Không ghi được cấu hình khoá lên cloud.' }
  }
  return { ok: true, action: 'none' }
}

/** Đồng bộ ngay (an toàn khi gọi lặp). */
export function syncGuardConfig(): Promise<GuardSyncResult> {
  return serialize(doSync).then((r) => {
    dbg(`[guardsync] ${r.ok ? 'OK' : 'FAIL'} action=${r.action ?? '-'}${r.error ? ' err=' + r.error : ''}`)
    return r
  })
}

// ── Tự động hoá ──────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

/** Gọi khi tài khoản cloud vừa đăng nhập: bật bộ hẹn giờ nền (lần đồng bộ đầu do cloud:setSession chờ). */
export function onGuardLogin(): void {
  if (timer) return
  timer = setInterval(() => {
    if (getCloudSession()) void syncGuardConfig().catch(() => {})
  }, 15 * 60_000)
  timer.unref?.()
}

// Mỗi khi cấu hình khoá đổi (đặt/gỡ khoá, mật khẩu, giới hạn, tự huỷ) → đẩy lên cloud sau ~2 giây.
setGuardChangeListener(() => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void syncGuardConfig().catch(() => {}), 2_000)
  debounce.unref?.()
})
