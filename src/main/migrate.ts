// ── VGC Browser — chuyển dữ liệu từ cloud sang máy chủ công ty ────────────────
// App chỉ: (1) đẩy nốt dữ liệu trên máy lên cloud (renderer làm phần profile/proxy; đây làm
// két passkey + cấu hình khoá), (2) nhờ máy chủ công ty chép tài khoản này từ cloud sang
// (server/migrate/server.mjs), (3) hỏi tiến độ. Mật khẩu chỉ đi thẳng tới máy chủ công ty,
// không lưu ở đâu.
import { MIGRATION } from './targets'
import { getCloudEmail, getCloudSession } from './session'
import { syncPasskeyVault } from './passkey-vault'
import { syncGuardConfig } from './guard-sync'
import type { MigrationPrep, MigrationStatus } from '../shared/types'

function requireMigration(): NonNullable<typeof MIGRATION> {
  if (!MIGRATION) throw new Error('Bản này không có chức năng chuyển dữ liệu.')
  if (!getCloudSession()) throw new Error('Hãy đăng nhập VGC trước.')
  return MIGRATION
}

/** Đẩy két passkey + cấu hình khoá của tài khoản lên cloud ngay (bình thường chạy nền). */
export async function migrationPrepare(): Promise<MigrationPrep> {
  requireMigration()
  const out: MigrationPrep = { passkeys: { ok: false }, guard: { ok: false } }
  try {
    const r = await syncPasskeyVault()
    out.passkeys = { ok: r.ok, total: r.total, error: r.error }
  } catch (e) {
    out.passkeys = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    const r = await syncGuardConfig()
    out.guard = { ok: r.ok, error: r.error }
  } catch (e) {
    out.guard = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return out
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const m = requireMigration()
  const r = await fetch(`${m.url}${path}`, {
    ...init,
    headers: { ...m.headers, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
    cache: 'no-store'
  })
  const text = await r.text()
  let j: unknown = null
  try {
    j = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }
  if (!r.ok) {
    const msg = (j as { error?: string } | null)?.error
    throw new Error(msg || (r.status === 404 ? 'Không kết nối được máy chủ công ty.' : `Máy chủ công ty báo lỗi ${r.status}`))
  }
  return j as T
}

export async function migrationStart(password: string, full: boolean): Promise<string> {
  const email = getCloudEmail()
  if (!email) throw new Error('Không đọc được email tài khoản đang đăng nhập.')
  if (typeof password !== 'string' || !password || password.length > 512) throw new Error('Nhập mật khẩu VGC.')
  const r = await call<{ job: string }>('/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, full: full === true })
  })
  if (!r?.job || !/^[A-Za-z0-9_-]{10,64}$/.test(r.job)) throw new Error('Máy chủ trả mã không hợp lệ.')
  return r.job
}

export function migrationStatus(job: string): Promise<MigrationStatus> {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(String(job))) throw new Error('Mã lượt chuyển không hợp lệ.')
  return call<MigrationStatus>(`/status?job=${encodeURIComponent(job)}`, { method: 'GET' })
}
