// ── VGC Browser — két passkey THEO TÀI KHOẢN (đồng bộ cloud tự động) ───────────
// Passkey của mỗi profile nằm trong `Default/vgc-passkeys.enc` (passkeys.ts) và đi theo gói phiên
// của profile. Gói phiên có thể cũ / bị ghi đè / mất cùng profile, mà mất passkey có thể mất luôn
// tài khoản trên site. Nên ngoài ra có MỘT két riêng cấp tài khoản trên cloud:
//   Storage `<uid>/00000000-0000-4000-8000-706b7661756c.cookiesdb.json`  = JSON { profiles: {profileId: PkCred[]}, tomb } mã hoá bằng khoá
//   tài khoản (AES-256-GCM, context `pkvault:<uid>`), độc lập với gói phiên từng profile.
// Tự động, không cần bấm gì:
//   • tạo / xoá / khôi phục passkey  → đẩy lên két sau ~3 giây;
//   • đăng nhập tài khoản             → quét két và kéo passkey về các profile đang có (+ lần nữa ~45 s sau,
//                                       khi danh sách profile đã kéo xong);
//   • MỞ một profile                  → hợp nhất két vào profile trước khi chạy (sau khi tải phiên);
//   • mỗi 15 phút                     → đồng bộ nền.
// Hợp nhất kiểu HỢP (union theo credentialId) + "bia mộ" cho passkey đã xoá nên hai máy cùng thêm
// passkey không làm mất của nhau, và passkey đã xoá không sống lại. Lỗi mạng / giải mã không bao giờ
// bị coi là "két rỗng" để ghi đè.
// TỰ HUỶ: wipePasskeysFor() xoá passkey của profile bị huỷ khỏi két (kèm bia mộ cho các máy khác) và
// xoá các bản sao lưu cục bộ — để "xoá vĩnh viễn" không bị hở qua két.

import { decryptBytes, encryptBytes, getAccountSecret, isEncryptedBytes } from './account-secret'
import { accountObject } from './cloud-data'
import { dbg } from './dbg'
import { getCloudSession } from './session'
import { listProfiles } from './store'
import {
  listLocalPasskeyProfileIds,
  mergeProfileStore,
  purgePasskeyBackups,
  readProfileStore,
  setPasskeyChangeListener,
  type PkCred
} from './passkeys'

interface Vault {
  v: 1
  updated: string
  profiles: Record<string, PkCred[]>
  tomb: Record<string, string>
}
export interface VaultSyncResult {
  ok: boolean
  error?: string
  pulled?: number // passkey mới kéo về máy này
  removed?: number // passkey bị gỡ vì bia mộ
  pushed?: boolean // có ghi két mới lên cloud
  total?: number // tổng passkey trong két sau đồng bộ
}

// Chính sách RLS của bucket `profiles` (supabase/storage.sql) CHỈ cho phép tên `<uid>/<uuid>.(zip|cookies.json|
// passwords.json|cookiesdb.json)`. Nên két dùng một "mã profile" cố định, không bao giờ trùng profile thật
// (UUID 00000000-0000-4000-8000-706b7661756c, 706b7661756c = "pkvaul") + đuôi hợp lệ — chạy được ngay,
// không phải sửa SQL trên Supabase.
const OBJECT = '00000000-0000-4000-8000-706b7661756c.cookiesdb.json'
const ctx = (uid: string): string => `pkvault:${uid}`
const emptyVault = (): Vault => ({ v: 1, updated: new Date().toISOString(), profiles: {}, tomb: {} })

let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function fetchVault(secret: string, uid: string): Promise<{ vault: Vault; exists: boolean } | null> {
  const r = await accountObject('get', OBJECT)
  if (!r.ok) return null
  if (!r.data) return { vault: emptyVault(), exists: false }
  if (!isEncryptedBytes(r.data)) return null
  const plain = decryptBytes(secret, ctx(uid), r.data)
  if (!plain) return null
  try {
    const v = JSON.parse(plain.toString('utf8')) as Vault
    if (!v || v.v !== 1 || typeof v.profiles !== 'object') return null
    if (!v.tomb || typeof v.tomb !== 'object') v.tomb = {}
    return { vault: v, exists: true }
  } catch {
    return null
  }
}

async function putVault(secret: string, uid: string, vault: Vault): Promise<boolean> {
  vault.updated = new Date().toISOString()
  const data = encryptBytes(secret, ctx(uid), Buffer.from(JSON.stringify(vault), 'utf8'))
  return (await accountObject('put', OBJECT, data)).ok
}

/** Dạng chuẩn hoá (sắp xếp, bỏ `updated`) để so sánh có thay đổi thật hay không. */
function canonical(v: Vault): string {
  const profiles: Record<string, PkCred[]> = {}
  for (const id of Object.keys(v.profiles).sort()) {
    const list = [...v.profiles[id]].sort((a, b) => a.id.localeCompare(b.id))
    if (list.length) profiles[id] = list
  }
  const tomb: Record<string, string> = {}
  for (const k of Object.keys(v.tomb).sort()) tomb[k] = v.tomb[k]
  return JSON.stringify({ profiles, tomb })
}

function unionCreds(a: PkCred[], b: PkCred[], tomb: Record<string, string>): PkCred[] {
  const byId = new Map<string, PkCred>()
  for (const c of [...a, ...b]) {
    if (!c || typeof c.id !== 'string' || tomb[c.id]) continue
    const cur = byId.get(c.id)
    if (!cur || (c.lastUsed ?? '') > (cur.lastUsed ?? '')) byId.set(c.id, c)
  }
  return [...byId.values()]
}

const countCreds = (v: Vault): number => Object.values(v.profiles).reduce((n, l) => n + l.length, 0)

/** Quét két + kho cục bộ, hợp nhất hai chiều, ghi lại nếu có thay đổi. An toàn khi gọi lặp. */
export function syncPasskeyVault(): Promise<VaultSyncResult> {
  return serialize(doSync).then((r) => {
    dbg(`[pkvault] sync ${r.ok ? 'OK' : 'FAIL'} pulled=${r.pulled ?? 0} removed=${r.removed ?? 0} pushed=${r.pushed ?? false} total=${r.total ?? 0}${r.error ? ' err=' + r.error : ''}`)
    return r
  })
}

async function doSync(): Promise<VaultSyncResult> {
  {
    const session = getCloudSession()
    if (!session) return { ok: false, error: 'Chưa đăng nhập cloud.' }
    const secret = await getAccountSecret()
    if (!secret) return { ok: false, error: 'Chưa mở khoá mã hoá cloud.' }
    const cloud = await fetchVault(secret, session.uid)
    if (!cloud) return { ok: false, error: 'Không đọc được két passkey trên cloud (mạng hoặc khoá mã hoá).' }

    // 1) KÉO: két → kho cục bộ của các profile đang có trên tài khoản này.
    const valid = new Set((await listProfiles()).map((p) => p.id))
    let pulled = 0
    let removed = 0
    const localIds = await listLocalPasskeyProfileIds()
    for (const id of new Set([...Object.keys(cloud.vault.profiles), ...localIds])) {
      if (!valid.has(id)) continue
      try {
        const r = await mergeProfileStore(id, cloud.vault.profiles[id] ?? [], cloud.vault.tomb)
        pulled += r.added
        removed += r.removed
      } catch {
        /* một profile lỗi không chặn các profile khác */
      }
    }

    // 2) ĐẨY: dựng két mới = hợp(két cloud, kho cục bộ) trừ bia mộ.
    const next: Vault = { v: 1, updated: '', profiles: {}, tomb: { ...cloud.vault.tomb } }
    const locals = new Map<string, PkCred[]>()
    for (const id of localIds) {
      const store = await readProfileStore(id)
      if (!store) continue // không đọc được → giữ nguyên bản trên cloud cho profile này
      locals.set(id, store.creds)
      Object.assign(next.tomb, store.tomb ?? {})
    }
    for (const id of new Set([...Object.keys(cloud.vault.profiles), ...locals.keys()])) {
      const list = unionCreds(cloud.vault.profiles[id] ?? [], locals.get(id) ?? [], next.tomb)
      if (list.length) next.profiles[id] = list
    }
    const changed = canonical(next) !== canonical(cloud.vault)
    let pushed = false
    if (changed && (countCreds(next) > 0 || Object.keys(next.tomb).length > 0 || cloud.exists)) {
      if (!(await putVault(secret, session.uid, next))) return { ok: false, error: 'Không ghi được két lên cloud.', pulled, removed }
      pushed = true
    }
    return { ok: true, pulled, removed, pushed, total: countCreds(changed ? next : cloud.vault) }
  }
}

/**
 * Tự huỷ: xoá passkey của các profile (null = TẤT CẢ) khỏi két và các bản sao lưu cục bộ.
 * Ghi bia mộ cho mọi passkey bị xoá để máy khác không đẩy lại. Trả true nếu két đã sạch.
 */
export function wipePasskeysFor(profileIds: string[] | null): Promise<boolean> {
  return serialize(async () => {
    await purgePasskeyBackups(profileIds)
    const session = getCloudSession()
    if (!session) return false
    const secret = await getAccountSecret()
    if (!secret) return false
    const cloud = await fetchVault(secret, session.uid)
    if (!cloud) return false
    if (!cloud.exists) return true
    const now = new Date().toISOString()
    const targets = profileIds ?? Object.keys(cloud.vault.profiles)
    for (const id of targets) {
      for (const c of cloud.vault.profiles[id] ?? []) cloud.vault.tomb[c.id] = now
      delete cloud.vault.profiles[id]
    }
    return putVault(secret, session.uid, cloud.vault)
  })
}

// ── Tự động hoá ──────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

function startTimer(): void {
  if (timer) return
  timer = setInterval(() => {
    if (getCloudSession()) void syncPasskeyVault().catch(() => {})
  }, 15 * 60_000)
  timer.unref?.()
}

/** Gọi khi tài khoản cloud vừa đăng nhập: quét két và kéo passkey về (2 lần, vì danh sách profile kéo chậm hơn). */
export function onCloudLogin(): void {
  startTimer()
  for (const ms of [4_000, 45_000]) {
    const t = setTimeout(() => void syncPasskeyVault().catch(() => {}), ms)
    t.unref?.()
  }
}

// Mỗi khi kho cục bộ đổi cấu trúc (tạo/xoá/khôi phục passkey) → đẩy lên két sau ~3 giây (gộp nhiều lần).
setPasskeyChangeListener(() => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void syncPasskeyVault().catch(() => {}), 3_000)
  debounce.unref?.()
})
