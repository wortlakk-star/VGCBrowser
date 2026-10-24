// ── VGC Browser — Khoá bảo vệ profile ("tự huỷ khi nhập sai") ────────────────
// Mỗi profile có thể đặt MẬT KHẨU riêng. Khi mở profile đã khoá phải nhập đúng.
//   • Sai liên tiếp tới giới hạn RIÊNG (mặc định 3) → xoá VĨNH VIỄN riêng profile đó.
//   • Tổng số lần sai (mọi profile) tới giới hạn CHUNG (mặc định 5) → xoá TẤT CẢ.
//   • MẬT KHẨU CHỦ (admin): mở được mọi profile, không tính là sai, không kích hoạt xoá.
//   • MẬT KHẨU SOS (admin): gõ vào ô bất kỳ → xoá sạch TẤT CẢ ngay (dùng khi bị ép mở);
//     giao diện vẫn báo "sai mật khẩu" để người ép không biết.
// Chỉ lưu MÃ BĂM (scrypt + salt), không lưu mật khẩu thật. Cấu hình + bộ đếm lưu MÃ HOÁ
// (secure-store, khoá theo máy) để tắt/mở app không reset được bộ đếm.
//
// ⚠️ Logic nằm ở MAIN (không phải renderer) để không bị qua mặt bằng devtools.

import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { rename, rm } from 'fs/promises'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { readSecureJson, writeSecureJson } from './secure-store'
import { deleteProfile, listProfiles, removeMany } from './store'
import { deleteProfileCloudData } from './cloud-data'
import { wipePasskeysFor } from './passkey-vault'
import { getCloudSession } from './session'

interface PwHash {
  salt: string // hex
  hash: string // hex (scrypt, 64 byte)
}
interface ProfileLock {
  // Mô hình mới: KHÔNG có mật khẩu riêng — mở bằng MẬT KHẨU CHỦ chung. `pw` chỉ còn để
  // tương thích dữ liệu cũ (các lock đặt trong lúc thử nghiệm); không tạo mới nữa.
  pw?: PwHash
  limit: number // số lần sai riêng profile này trước khi xoá nó
  wrong: number // số lần sai liên tiếp hiện tại
}
/** Khoá theo NHÓM: nhóm có mã riêng; profile trong nhóm bị ẩn tới khi nhập đúng mã. */
interface GroupLock {
  pw: PwHash
  limit: number // sai mấy lần thì xoá cả nhóm
  wrong: number
}
interface GuardConfig {
  master: PwHash | null
  sos: PwHash | null
  perProfileLimit: number
  globalLimit: number
  globalWrong: number
  /** Số phút hệ thống không có thao tác thì cửa sổ trình duyệt của profile khoá tự khoá lại (0 = tắt). */
  relockMinutes: number
  profiles: Record<string, ProfileLock>
  groups: Record<string, GroupLock> // key = tên nhóm
  /** Số phiên bản cấu hình (thời điểm sửa gần nhất, ms). Tăng mỗi khi cấu hình ĐỒNG BỘ thay đổi; dùng để
   *  quyết định bên nào (máy này hay cloud) mới hơn — xem guard-sync.ts. Bộ đếm sai KHÔNG tính. */
  rev: number
}

const DEFAULTS: GuardConfig = {
  master: null,
  sos: null,
  perProfileLimit: 3,
  globalLimit: 5,
  globalWrong: 0,
  relockMinutes: 5,
  profiles: {},
  groups: {},
  rev: 0
}

export type UnlockAction = 'ok' | 'master' | 'wrong' | 'wiped-profile' | 'wiped-all' | 'sos'
export interface UnlockResult {
  ok: boolean
  action: UnlockAction
  remainingProfile?: number | null
  remainingGlobal?: number
}

// Cấu hình khoá lưu THEO TÀI KHOẢN (mỗi tài khoản một file) để đăng nhập tài khoản khác trên cùng
// máy không lẫn cấu hình, và để đồng bộ cloud theo tài khoản (guard-sync.ts).
// Chưa đăng nhập = 'local' → file cũ `profile-guard.enc`.
function currentUid(): string {
  return getCloudSession()?.uid ?? 'local'
}
function fileFor(uid: string): string {
  return join(app.getPath('userData'), uid === 'local' ? 'profile-guard.enc' : `profile-guard-${uid}.enc`)
}

let cache: GuardConfig | null = null
let cacheUid = ''
let loading: Promise<GuardConfig> | null = null
let loadingUid = ''
let mutate: Promise<unknown> = Promise.resolve()

/** Đọc file của tài khoản. Tài khoản chưa có file riêng thì NHẬN file cũ dùng chung của máy (cấu hình
 *  tạo trước khi có đồng bộ) nếu chưa tài khoản nào nhận; file cũ được đổi tên để không ai nhận lại. */
async function readOrClaim(uid: string): Promise<Partial<GuardConfig> | null> {
  const own = await readSecureJson<Partial<GuardConfig>>(fileFor(uid)).catch(() => null)
  if (own || uid === 'local') return own
  const legacy = fileFor('local')
  const old = await readSecureJson<Partial<GuardConfig>>(legacy).catch(() => null)
  if (!old) return null
  old.rev = 0 // cấu hình một-máy chưa từng đồng bộ → để guard-sync GỘP với bản trên cloud thay vì ghi đè
  await writeSecureJson(fileFor(uid), old)
  await rename(legacy, `${legacy}.claimed-${uid}`).catch(() => {})
  return old
}

async function load(): Promise<GuardConfig> {
  const uid = currentUid()
  if (cache && cacheUid === uid) return cache
  if (loading && loadingUid === uid) return loading
  loadingUid = uid
  loading = (async () => {
    if (cache && cacheUid !== uid) {
      // Đổi tài khoản: huỷ mọi vé mở khoá và phiên admin của tài khoản trước.
      tickets.clear()
      adminUntil = 0
    }
    const cfg = normalize(await readOrClaim(uid))
    cache = cfg
    cacheUid = uid
    return cfg
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

// ── Đồng bộ cloud (guard-sync.ts) ────────────────────────────────────────────
export interface GuardSyncData {
  v: 1
  rev: number
  master: PwHash | null
  sos: PwHash | null
  perProfileLimit: number
  globalLimit: number
  relockMinutes: number
  profiles: Record<string, { limit: number; pw?: PwHash }>
  groups: Record<string, { pw: PwHash; limit: number }>
}
const toSyncData = (cfg: GuardConfig): GuardSyncData => ({
  v: 1,
  rev: cfg.rev,
  master: cfg.master,
  sos: cfg.sos,
  perProfileLimit: cfg.perProfileLimit,
  globalLimit: cfg.globalLimit,
  relockMinutes: cfg.relockMinutes,
  profiles: Object.fromEntries(
    Object.keys(cfg.profiles)
      .sort()
      .map((id) => [id, { limit: cfg.profiles[id].limit, ...(cfg.profiles[id].pw ? { pw: cfg.profiles[id].pw } : {}) }])
  ),
  groups: Object.fromEntries(
    Object.keys(cfg.groups)
      .sort()
      .map((n) => [n, { pw: cfg.groups[n].pw, limit: cfg.groups[n].limit }])
  )
})
/** Chữ ký phần cấu hình ĐỒNG BỘ (bỏ rev, bỏ bộ đếm sai) — đổi chữ ký = có thay đổi cần đẩy lên cloud. */
const syncSignature = (cfg: GuardConfig): string => {
  const d = toSyncData(cfg) as Partial<GuardSyncData>
  delete d.rev
  return JSON.stringify(d)
}
const hasAnyConfig = (cfg: GuardConfig): boolean =>
  !!cfg.master || !!cfg.sos || Object.keys(cfg.profiles).length > 0 || Object.keys(cfg.groups).length > 0

let changeListener: (() => void) | null = null
/** guard-sync đăng ký để biết khi cấu hình đồng bộ vừa đổi (→ đẩy lên cloud). */
export function setGuardChangeListener(fn: (() => void) | null): void {
  changeListener = fn
}
function broadcastGuardChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('guard:changed')
    } catch {
      /* cửa sổ đã đóng */
    }
  }
}

/** Ảnh chụp cấu hình đồng bộ hiện tại của tài khoản đang đăng nhập. */
export async function guardSyncSnapshot(): Promise<{ data: GuardSyncData; hasConfig: boolean }> {
  const cfg = await load()
  return { data: toSyncData(cfg), hasConfig: hasAnyConfig(cfg) }
}

/** Cấu hình cũ chưa từng đồng bộ (rev = 0) mà đang có nội dung → gán rev để đẩy lên cloud. */
export function guardEnsureRev(): Promise<number> {
  return withWrite((cfg) => {
    if (cfg.rev === 0 && hasAnyConfig(cfg)) cfg.rev = Date.now()
    return cfg.rev
  }, false)
}

/**
 * Nhận cấu hình từ cloud (mới hơn bản trên máy). Giữ nguyên BỘ ĐẾM SAI của máy này. Nếu bản trên máy là
 * cấu hình cũ chưa đồng bộ (union = true) thì GỘP thêm các khoá profile/nhóm của máy vào (khoá nhiều hơn
 * thay vì mất khoá) và coi như vừa sửa để đẩy lại. Trả true nếu cấu hình thật sự thay đổi.
 */
export function applyRemoteGuard(remote: GuardSyncData, union: boolean): Promise<boolean> {
  return withWrite((cfg) => {
    const before = syncSignature(cfg)
    const next = normalize({
      master: remote.master,
      sos: remote.sos,
      perProfileLimit: remote.perProfileLimit,
      globalLimit: remote.globalLimit,
      relockMinutes: remote.relockMinutes,
      profiles: Object.fromEntries(
        Object.entries(remote.profiles ?? {}).map(([id, v]) => [id, { ...v, wrong: cfg.profiles[id]?.wrong ?? 0 }])
      ),
      groups: Object.fromEntries(
        Object.entries(remote.groups ?? {}).map(([n, v]) => [n, { ...v, wrong: cfg.groups[n]?.wrong ?? 0 }])
      ),
      globalWrong: cfg.globalWrong,
      rev: remote.rev
    } as unknown as Partial<GuardConfig>)
    if (union) {
      for (const [id, v] of Object.entries(cfg.profiles)) if (!next.profiles[id]) next.profiles[id] = v
      for (const [n, v] of Object.entries(cfg.groups)) if (!next.groups[n]) next.groups[n] = v
    }
    Object.assign(cfg, next)
    const changed = syncSignature(cfg) !== before
    if (union && changed) cfg.rev = Math.max(Date.now(), remote.rev + 1)
    if (changed) broadcastGuardChanged()
    return changed
  }, false)
}

function normalize(s: Partial<GuardConfig> | null): GuardConfig {
  const out: GuardConfig = { ...DEFAULTS, profiles: {}, groups: {} }
  if (!s || typeof s !== 'object') return out
  out.master = isHash(s.master) ? s.master! : null
  out.sos = isHash(s.sos) ? s.sos! : null
  out.perProfileLimit = clampInt(s.perProfileLimit, 1, 99, DEFAULTS.perProfileLimit)
  out.globalLimit = clampInt(s.globalLimit, 1, 999, DEFAULTS.globalLimit)
  out.relockMinutes = clampInt(s.relockMinutes, 0, 1440, DEFAULTS.relockMinutes)
  out.globalWrong = clampInt(s.globalWrong, 0, 1_000_000, 0)
  out.rev = clampInt(s.rev, 0, Number.MAX_SAFE_INTEGER, 0)
  if (s.profiles && typeof s.profiles === 'object') {
    for (const [id, v] of Object.entries(s.profiles)) {
      if (v && typeof v === 'object') {
        const lock = v as ProfileLock
        out.profiles[id] = {
          ...(isHash(lock.pw) ? { pw: lock.pw } : {}),
          limit: clampInt(lock.limit, 1, 99, out.perProfileLimit),
          wrong: clampInt(lock.wrong, 0, 99, 0)
        }
      }
    }
  }
  if (s.groups && typeof s.groups === 'object') {
    for (const [name, v] of Object.entries(s.groups)) {
      if (v && isHash((v as GroupLock).pw)) {
        out.groups[name] = {
          pw: (v as GroupLock).pw,
          limit: clampInt((v as GroupLock).limit, 1, 99, out.perProfileLimit),
          wrong: clampInt((v as GroupLock).wrong, 0, 99, 0)
        }
      }
    }
  }
  return out
}

function isHash(h: unknown): h is PwHash {
  return (
    !!h &&
    typeof h === 'object' &&
    typeof (h as PwHash).salt === 'string' &&
    typeof (h as PwHash).hash === 'string'
  )
}
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/** Serialize all writes so two unlock attempts can't both read-modify-write stale state. */
function withWrite<T>(fn: (cfg: GuardConfig) => Promise<T> | T, bump = true): Promise<T> {
  const run = mutate.then(async () => {
    const cfg = await load()
    const uid = cacheUid
    const before = syncSignature(cfg)
    const result = await fn(cfg)
    // Phần cấu hình ĐỒNG BỘ đổi (không tính bộ đếm sai) → tăng rev và báo guard-sync đẩy lên cloud.
    const changed = bump && syncSignature(cfg) !== before
    if (changed) cfg.rev = Math.max(Date.now(), cfg.rev + 1)
    await writeSecureJson(fileFor(uid), cfg)
    cache = cfg
    if (changed) {
      try {
        changeListener?.()
      } catch {
        /* lỗi của đồng bộ không được làm hỏng thao tác khoá */
      }
    }
    return result
  })
  mutate = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function makeHash(pw: string): PwHash {
  const salt = randomBytes(16)
  const hash = scryptSync(pw, salt, 64)
  return { salt: salt.toString('hex'), hash: hash.toString('hex') }
}
function verify(pw: string, h: PwHash | null): boolean {
  if (!h || !pw) return false
  try {
    const derived = scryptSync(pw, Buffer.from(h.salt, 'hex'), 64)
    const stored = Buffer.from(h.hash, 'hex')
    return stored.length === derived.length && timingSafeEqual(stored, derived)
  } catch {
    return false
  }
}

/** Người gọi phải chứng minh quyền admin để đổi/gỡ khoá. Khi CHƯA đặt mật khẩu chủ thì
 *  cho phép (thiết lập lần đầu). Đã đặt → bắt buộc đúng mật khẩu chủ. */
function hasAdmin(cfg: GuardConfig, auth: string | undefined): boolean {
  if (!cfg.master) return true
  return verify(auth ?? '', cfg.master)
}

// ── Vé mở khoá tạm (one-shot) ────────────────────────────────────────────────
// unlock() thành công → cấp vé; launchProfile() ở main tiêu vé. Renderer không thể
// tự mở profile đã khoá mà không qua unlock().
const tickets = new Map<string, number>()
const TICKET_TTL = 2 * 60_000
function grantTicket(id: string): void {
  tickets.set(id, Date.now() + TICKET_TTL)
}
export function consumeUnlock(id: string): boolean {
  const exp = tickets.get(id)
  if (exp && exp > Date.now()) {
    tickets.delete(id)
    return true
  }
  tickets.delete(id)
  return false
}

// ── API đọc trạng thái ───────────────────────────────────────────────────────
export async function isLocked(id: string): Promise<boolean> {
  return !!(await load()).profiles[id]
}
export async function lockedIds(): Promise<string[]> {
  return Object.keys((await load()).profiles)
}
// Phiên admin: sau khi nhập đúng mật khẩu bảo mật (checkAdmin), được phép BẬT/TẮT khoá
// cho từng profile mà KHÔNG phải gõ lại mật khẩu trong khoảng thời gian này.
let adminUntil = 0
const ADMIN_TTL = 30 * 60_000
function adminActive(): boolean {
  return adminUntil > Date.now()
}

/** Kiểm tra "mật khẩu bảo mật" để HIỆN phần khoá bảo vệ (ẩn mặc định). Dùng mật khẩu chủ.
 *  Khi CHƯA đặt mật khẩu chủ → cho phép mở để thiết lập lần đầu. Mở đúng → bật phiên admin. */
export async function checkAdmin(pw: string): Promise<boolean> {
  const cfg = await load()
  const ok = !cfg.master || verify(pw, cfg.master)
  if (ok) adminUntil = Date.now() + ADMIN_TTL
  return ok
}

export async function guardStatus(): Promise<{
  hasMaster: boolean
  hasSos: boolean
  perProfileLimit: number
  globalLimit: number
  globalWrong: number
  lockedCount: number
  relockMinutes: number
}> {
  const cfg = await load()
  return {
    hasMaster: !!cfg.master,
    hasSos: !!cfg.sos,
    perProfileLimit: cfg.perProfileLimit,
    globalLimit: cfg.globalLimit,
    globalWrong: cfg.globalWrong,
    lockedCount: Object.keys(cfg.profiles).length,
    relockMinutes: cfg.relockMinutes
  }
}

// ── Đặt/gỡ mật khẩu ──────────────────────────────────────────────────────────
export async function setMaster(newPw: string, auth?: string): Promise<{ ok: boolean; error?: string }> {
  return withWrite((cfg) => {
    if (!hasAdmin(cfg, auth)) return { ok: false, error: 'Sai mật khẩu chủ hiện tại.' }
    cfg.master = newPw ? makeHash(newPw) : null
    return { ok: true }
  })
}
export async function setSos(newPw: string, auth?: string): Promise<{ ok: boolean; error?: string }> {
  return withWrite((cfg) => {
    if (!adminActive() && !hasAdmin(cfg, auth)) return { ok: false, error: 'Sai mật khẩu chủ hiện tại.' }
    cfg.sos = newPw ? makeHash(newPw) : null
    return { ok: true }
  })
}
/** BẬT/TẮT khoá cho 1 profile. Dùng chung MẬT KHẨU CHỦ (đặt trong Cài đặt) — không có
 *  mật khẩu riêng từng profile. Chỉ cần đang trong phiên admin (đã nhập đúng mật khẩu bảo mật).
 *  locked=true → profile này phải nhập mật khẩu chủ mới mở; false → gỡ khoá. */
export async function setProfileLock(
  id: string,
  locked: boolean,
  limit?: number
): Promise<{ ok: boolean; error?: string }> {
  if (!adminActive()) return { ok: false, error: 'Hãy mở khoá bảo mật trong Cài đặt trước.' }
  return withWrite((cfg) => {
    if (locked && !cfg.master) {
      return { ok: false, error: 'Chưa đặt mật khẩu chủ trong Cài đặt — hãy đặt trước khi khoá profile.' }
    }
    if (!locked) {
      delete cfg.profiles[id]
      return { ok: true }
    }
    const cur = cfg.profiles[id]
    cfg.profiles[id] = {
      limit: clampInt(limit, 1, 99, cfg.perProfileLimit),
      wrong: cur?.wrong ?? 0
    }
    return { ok: true }
  })
}
export async function setLimits(
  perProfileLimit: number,
  globalLimit: number,
  auth?: string
): Promise<{ ok: boolean; error?: string }> {
  return withWrite((cfg) => {
    if (!adminActive() && !hasAdmin(cfg, auth)) return { ok: false, error: 'Sai mật khẩu chủ hiện tại.' }
    cfg.perProfileLimit = clampInt(perProfileLimit, 1, 99, cfg.perProfileLimit)
    cfg.globalLimit = clampInt(globalLimit, 1, 999, cfg.globalLimit)
    return { ok: true }
  })
}

/** Số phút không thao tác thì cửa sổ trình duyệt của profile khoá tự khoá lại (0 = tắt). */
export async function getRelockMinutes(): Promise<number> {
  return (await load()).relockMinutes
}
export async function setRelockMinutes(minutes: number): Promise<{ ok: boolean; error?: string }> {
  if (!adminActive()) return { ok: false, error: 'Hãy mở khoá bảo mật trong Cài đặt trước.' }
  return withWrite((cfg) => {
    cfg.relockMinutes = clampInt(minutes, 0, 1440, cfg.relockMinutes)
    return { ok: true }
  })
}

// ── Mở khoá (chỗ đếm sai + quyết định xoá) ───────────────────────────────────
export async function unlock(id: string, pw: string, grant = true): Promise<UnlockResult> {
  return withWrite((cfg) => {
    const entry = cfg.profiles[id]
    // SOS: xoá tất cả nhưng GIẢ VỜ báo sai (không để kẻ ép biết).
    if (verify(pw, cfg.sos)) {
      void wipeAll('sos')
      return { ok: false, action: 'sos' as const }
    }
    // Mật khẩu chủ: mở, reset mọi bộ đếm.
    if (verify(pw, cfg.master)) {
      if (entry) entry.wrong = 0
      cfg.globalWrong = 0
      if (grant) grantTicket(id)
      return { ok: true, action: 'master' as const }
    }
    // Tương thích dữ liệu cũ: lock từng-profile có mật khẩu riêng (thử nghiệm trước đây).
    if (entry && verify(pw, entry.pw ?? null)) {
      entry.wrong = 0
      cfg.globalWrong = 0
      if (grant) grantTicket(id)
      return { ok: true, action: 'ok' as const }
    }
    // SAI: tăng bộ đếm riêng + chung.
    if (entry) entry.wrong += 1
    cfg.globalWrong += 1
    const perLimit = entry?.limit ?? cfg.perProfileLimit
    if (cfg.globalWrong >= cfg.globalLimit) {
      void wipeAll('global')
      return { ok: false, action: 'wiped-all' as const }
    }
    if (entry && entry.wrong >= perLimit) {
      const targetId = id
      void wipeProfile(targetId, 'perprofile')
      return { ok: false, action: 'wiped-profile' as const }
    }
    return {
      ok: false,
      action: 'wrong' as const,
      remainingProfile: entry ? Math.max(0, perLimit - entry.wrong) : null,
      remainingGlobal: Math.max(0, cfg.globalLimit - cfg.globalWrong)
    }
  })
}

// ── Khoá theo NHÓM ────────────────────────────────────────────────────────────
export async function lockedGroupNames(): Promise<string[]> {
  return Object.keys((await load()).groups)
}
export async function isGroupLocked(name: string): Promise<boolean> {
  return !!(await load()).groups[name]
}
/** Đặt/đổi/gỡ mã khoá cho một nhóm. code rỗng = gỡ khoá nhóm. Cần đang trong phiên admin. */
export async function setGroupLock(
  name: string,
  code: string,
  limit?: number
): Promise<{ ok: boolean; error?: string }> {
  if (!adminActive()) return { ok: false, error: 'Hãy mở khoá bảo mật trong Cài đặt trước.' }
  const g = String(name || '').trim()
  if (!g) return { ok: false, error: 'Tên nhóm trống.' }
  return withWrite((cfg) => {
    if (!code) {
      delete cfg.groups[g]
      return { ok: true }
    }
    cfg.groups[g] = { pw: makeHash(code), limit: clampInt(limit, 1, 99, cfg.perProfileLimit), wrong: 0 }
    return { ok: true }
  })
}

export interface GroupUnlockResult {
  ok: boolean
  action: 'ok' | 'master' | 'wrong' | 'wiped-group' | 'wiped-all' | 'sos'
  group?: string // tên nhóm vừa mở (ok) — hoặc '*' khi mật khẩu chủ mở tất cả
  remainingGlobal?: number
}
/** Nhập một mã để mở nhóm ẩn. Mã khớp nhóm nào → mở nhóm đó. Mật khẩu chủ → mở TẤT CẢ nhóm.
 *  SOS → xoá tất cả. Sai (không khớp) → tăng đếm chung; chạm mức chung → xoá tất cả. */
export async function unlockGroup(code: string): Promise<GroupUnlockResult> {
  return withWrite((cfg) => {
    if (verify(code, cfg.sos)) {
      void wipeAll('sos')
      return { ok: false, action: 'sos' as const }
    }
    if (verify(code, cfg.master)) {
      for (const g of Object.values(cfg.groups)) g.wrong = 0
      cfg.globalWrong = 0
      return { ok: true, action: 'master' as const, group: '*' }
    }
    for (const [name, g] of Object.entries(cfg.groups)) {
      if (verify(code, g.pw)) {
        g.wrong = 0
        cfg.globalWrong = 0
        return { ok: true, action: 'ok' as const, group: name }
      }
    }
    // Sai: không khớp nhóm nào.
    cfg.globalWrong += 1
    if (cfg.globalWrong >= cfg.globalLimit) {
      void wipeAll('global')
      return { ok: false, action: 'wiped-all' as const }
    }
    return { ok: false, action: 'wrong' as const, remainingGlobal: Math.max(0, cfg.globalLimit - cfg.globalWrong) }
  })
}

// ── Xoá vĩnh viễn ─────────────────────────────────────────────────────────────
function localProfileDir(id: string): string {
  return join(app.getPath('userData'), 'profiles', id)
}
function broadcastWiped(payload: { scope: 'profile' | 'all' | 'group'; id?: string; group?: string; reason: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('guard:wiped', payload)
    } catch {
      /* cửa sổ đã đóng */
    }
  }
}
async function stopEngine(id: string): Promise<void> {
  try {
    const mod = await import('./profile-manager')
    mod.stopProfile(id)
  } catch {
    /* profile-manager chưa sẵn sàng / không chạy */
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function wipeProfile(id: string, reason: string): Promise<void> {
  await stopEngine(id)
  await sleep(1500) // chờ engine nhả khoá file trước khi xoá thư mục
  await deleteProfileCloudData(id).catch(() => {})
  await wipePasskeysFor([id]).catch(() => false) // két passkey theo tài khoản + bản sao lưu cục bộ
  await rm(localProfileDir(id), { recursive: true, force: true }).catch(() => {})
  await deleteProfile(id).catch(() => {})
  await withWrite((cfg) => {
    delete cfg.profiles[id]
  })
  broadcastWiped({ scope: 'profile', id, reason })
}

/** Xoá vĩnh viễn toàn bộ profile thuộc một nhóm + gỡ khoá nhóm. */
export async function wipeGroup(name: string, reason: string): Promise<void> {
  const all = await listProfiles().catch(() => [])
  const inGroup = all.filter((p) => (p.group ?? '') === name)
  for (const p of inGroup) await stopEngine(p.id)
  await sleep(1500)
  await wipePasskeysFor(inGroup.map((p) => p.id)).catch(() => false)
  for (const p of inGroup) {
    await deleteProfileCloudData(p.id).catch(() => {})
    await rm(localProfileDir(p.id), { recursive: true, force: true }).catch(() => {})
  }
  await removeMany(inGroup.map((p) => p.id)).catch(() => {})
  await withWrite((cfg) => {
    for (const p of inGroup) delete cfg.profiles[p.id]
    delete cfg.groups[name]
  })
  broadcastWiped({ scope: 'group', group: name, reason })
}

export async function wipeAll(reason: string): Promise<void> {
  const profiles = await listProfiles().catch(() => [])
  for (const p of profiles) await stopEngine(p.id)
  await sleep(1500)
  for (const p of profiles) await deleteProfileCloudData(p.id).catch(() => {})
  await wipePasskeysFor(null).catch(() => false)
  await rm(join(app.getPath('userData'), 'profiles'), { recursive: true, force: true }).catch(() => {})
  await removeMany(profiles.map((p) => p.id)).catch(() => {})
  await withWrite((cfg) => {
    cfg.profiles = {}
    cfg.groups = {}
    cfg.globalWrong = 0
  })
  broadcastWiped({ scope: 'all', reason })
}
