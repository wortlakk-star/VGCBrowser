// ── VGC Browser — khoá cứng theo máy chủ công ty (chỉ bản VGC_TARGET=xeon) ──────
// Yêu cầu của chủ: máy chủ công ty tắt / mất kết nối → KHÔNG ai dùng được VGC.
//   • requireCompanyServer(): mở profile phải hỏi được máy chủ ngay lúc đó (không "cho qua").
//   • watchdog: hỏi máy chủ mỗi 30 giây; 4 lần liền không được (~2 phút) → đóng mọi profile
//     đang mở + báo giao diện khoá màn hình; máy chủ trả lời lại → mở khoá.
//   • đóng profile + lưu đủ lên máy chủ → xoá bản profile trên máy (profile-manager gọi
//     forgetLocalProfile), để máy nhân viên không giữ phiên đăng nhập nào khi máy chủ tắt.
// Bản cloud (supabase) và bản thử cloud giả không bị ảnh hưởng (COMPANY_MODE=false).
import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { CLOUD, CLOUD_TARGET } from './targets'
import { dbg } from './dbg'

export const COMPANY_MODE = CLOUD_TARGET === 'xeon'

// Máy chủ tắt (mất điện, rút mạng) → đóng mọi profile trong ~10 giây: ping mỗi 3 s, mỗi lần chờ tối đa 4 s,
// 3 lần hỏng LIÊN TIẾP mới đóng (một nhịp mạng chập chờn 1–2 lần không làm mất việc đang làm).
const PING_EVERY_MS = 3_000
const PING_TIMEOUT_MS = 4_000
const FAILS_TO_LOCK = 3
// Lệnh huỷ khẩn cấp chỉ cần hỏi mỗi ~30 s (10 nhịp ping tốt) — không tăng tải máy chủ so với trước.
const KILL_CHECK_EVERY_OK_TICKS = 10

export interface CompanyServerState {
  mode: boolean
  down: boolean
  lastOkAt: number
  reason: string
  /** Quản trị đang bật lệnh huỷ khẩn cấp. */
  killed?: boolean
}
let state: CompanyServerState = { mode: COMPANY_MODE, down: false, lastOkAt: 0, reason: '', killed: false }
let fails = 0
let okTicks = 0
let ticking = false
let timer: NodeJS.Timeout | null = null

export function companyServerState(): CompanyServerState {
  return { ...state }
}

/** Hỏi máy chủ công ty có đang chạy không (qua đúng đường app dùng: tunnel → cổng khoá → auth). */
export async function pingCompanyServer(timeoutMs = 10000): Promise<{ ok: boolean; reason: string }> {
  try {
    const r = await fetch(`${CLOUD.url}/auth/v1/health`, {
      headers: { apikey: CLOUD.anonKey },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'error'
    })
    await r.body?.cancel().catch(() => {})
    if (r.ok) return { ok: true, reason: '' }
    // 404 = cổng khoá không nhận app; 502/530 = máy chủ/đường hầm tắt; 503 = phân vùng đang khoá.
    return { ok: false, reason: `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.name : 'network' }
  }
}

/** Lần đầu đăng nhập máy chủ công ty (mỗi tài khoản một lần): đổi dấu đồng bộ cloud cũ → mới. */
export async function remapTagsAfterMigration(uid: string, accessToken: string): Promise<void> {
  if (!COMPANY_MODE) return
  const flag = join(app.getPath('userData'), `etag-remapped-${uid}.flag`)
  try {
    await fs.access(flag)
    return
  } catch {
    // chưa làm
  }
  try {
    const r = await fetch(`${CLOUD.url}/vgc/v1/migrate/etags`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
      redirect: 'error'
    })
    if (!r.ok) return
    const j = (await r.json()) as { map?: { name: string; src: string; dst: string }[] }
    const { remapSessionTags } = await import('./cloud-data')
    const n = await remapSessionTags(Array.isArray(j.map) ? j.map.slice(0, 100000) : [])
    await fs.writeFile(flag, new Date().toISOString(), { mode: 0o600 })
    dbg(`[company] remapped ${n} session tags after migration`)
  } catch (e) {
    dbg(`[company] tag remap failed: ${e instanceof Error ? e.message : e}`)
  }
}

export const SERVER_DOWN_MESSAGE =
  'Máy chủ công ty đang tắt hoặc mất kết nối — VGC tạm khoá. Báo quản trị bật máy chủ rồi thử lại.'

/** Gọi trước khi mở profile. Bản cloud: không làm gì. */
export async function requireCompanyServer(): Promise<void> {
  if (!COMPANY_MODE) return
  const p = await pingCompanyServer()
  if (!p.ok) {
    dbg(`[company] open refused: server unreachable (${p.reason})`)
    markDown(p.reason)
    throw new Error(SERVER_DOWN_MESSAGE)
  }
  markOk()
}

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('company:state', companyServerState())
  }
}
function markOk(): void {
  fails = 0
  const was = state.down
  const wasKilled = state.killed
  state = { ...state, down: false, lastOkAt: Date.now(), reason: '', killed: false }
  if (was || wasKilled) {
    dbg('[company] server back — unlocking')
    broadcast()
  }
}
function markDown(reason: string): void {
  const was = state.down
  state = { ...state, down: true, reason }
  if (!was) broadcast()
}

/** Máy chủ có đang phát lệnh huỷ khẩn cấp không (chỉ tin câu trả lời từ đúng máy chủ qua HTTPS). */
async function killRequested(): Promise<boolean> {
  try {
    const r = await fetch(`${CLOUD.url}/vgc/v1/state`, { signal: AbortSignal.timeout(6000), cache: 'no-store', redirect: 'error' })
    if (!r.ok) return false
    const j = (await r.json()) as { kill?: boolean }
    return j?.kill === true
  } catch {
    return false
  }
}

let wiping = false
/** Xoá sạch dữ liệu VGC trên máy này (giữ engine), rồi khởi động lại app về màn hình đăng nhập.
 *  Dữ liệu trên máy chủ KHÔNG bị đụng — chủ khôi phục được. */
const SENSITIVE = ['profiles', 'db', 'cloud-auth.enc', 'sync-meta', 'passkey-backups']
async function emergencyWipe(killProfiles: () => Promise<void>): Promise<void> {
  if (wiping) return
  const root = app.getPath('userData')
  const entries = await fs.readdir(root).catch(() => [] as string[])
  const hasData = entries.some((n) => SENSITIVE.includes(n) || /^(acct-secret|cloud-passphrase)-/.test(n))
  if (!hasData) {
    // Đã xoá rồi (lần khởi động sau lệnh huỷ): đứng ở màn hình khoá, không khởi động lại liên tục.
    const was = state.killed
    state = { ...state, down: true, killed: true, reason: 'killed' }
    if (!was) broadcast()
    return
  }
  wiping = true
  dbg('[company] KILL received — wiping local VGC data')
  await killProfiles().catch(() => {})
  const keep = new Set(['engine'])
  for (const name of entries) {
    if (keep.has(name)) continue
    await fs.rm(join(root, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
  app.relaunch()
  app.exit(0)
}

/** Bắt đầu canh máy chủ. onLost: đóng mọi profile (profile-manager.stopAllForServerLoss);
 *  onKill: giết mọi profile không lưu (profile-manager.emergencyKillProfiles). */
export function startCompanyWatchdog(onLost: () => Promise<void>, onKill: () => Promise<void>): void {
  if (!COMPANY_MODE || timer) return
  const tick = async (): Promise<void> => {
    // Không cho hai nhịp chồng nhau (ping chậm hơn chu kỳ) — mỗi lần hỏng phải là một lần hỏi thật.
    if (ticking) return
    ticking = true
    try {
      const p = await pingCompanyServer(PING_TIMEOUT_MS)
      if (p.ok) {
        okTicks++
        if (okTicks % KILL_CHECK_EVERY_OK_TICKS === 1 && (await killRequested())) return emergencyWipe(onKill)
        return markOk()
      }
      fails++
      dbg(`[company] ping failed ${fails}/${FAILS_TO_LOCK} (${p.reason})`)
      if (fails >= FAILS_TO_LOCK && !state.down) {
        markDown(p.reason)
        await onLost().catch((e) => dbg(`[company] close-all failed: ${e instanceof Error ? e.message : e}`))
      }
    } finally {
      ticking = false
    }
  }
  void tick()
  timer = setInterval(() => void tick(), PING_EVERY_MS)
  timer.unref()
}

// ── Chuyển hẳn khi đăng nhập lần đầu (bản 2.2.0) ─────────────────────────────────
// App KHÔNG nói chuyện với cloud: gửi email + mật khẩu cho máy chủ công ty; máy chủ tự lấy dữ liệu
// mới nhất của tài khoản từ cloud, đối chiếu 100%, rồi khoá — mỗi tài khoản đúng một lần.
export interface CutoverStatus {
  state: 'done' | 'skip' | 'running' | 'failed'
  step?: string
  done?: number
  total?: number
  error?: string
  profiles?: string
  files?: string
}
async function companyJson<T>(path: string, init: RequestInit): Promise<T> {
  const r = await fetch(`${CLOUD.url}${path}`, { ...init, signal: AbortSignal.timeout(30_000), cache: 'no-store', redirect: 'error' })
  const text = await r.text()
  let j: unknown = null
  try {
    j = text ? JSON.parse(text) : null
  } catch {
    /* không phải JSON */
  }
  if (!r.ok) throw new Error((j as { error?: string } | null)?.error || (r.status >= 500 || r.status === 404 ? SERVER_DOWN_MESSAGE : `Máy chủ báo lỗi ${r.status}`))
  return j as T
}
export async function cutoverStart(email: string, password: string): Promise<{ state: string; job?: string }> {
  if (!COMPANY_MODE) return { state: 'skip' }
  return companyJson('/vgc/v1/migrate/cutover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email).trim().slice(0, 320), password: String(password).slice(0, 512) })
  })
}
export async function cutoverStatus(job: string): Promise<CutoverStatus> {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(job)) throw new Error('Mã lượt chuyển không hợp lệ.')
  const st = await companyJson<{
    state: string
    step: string
    done: number
    total: number
    ok: boolean | null
    report: { errors?: string[]; tables?: Record<string, { match: number; cloud: number }>; files?: { verified: number; cloud: number } } | null
  }>(`/vgc/v1/migrate/status?job=${encodeURIComponent(job)}`, { method: 'GET' })
  const p = st.report?.tables?.profiles_cloud
  const f = st.report?.files
  const base = {
    step: st.step,
    done: st.done,
    total: st.total,
    profiles: p ? `${p.match}/${p.cloud}` : undefined,
    files: f ? `${f.verified}/${f.cloud}` : undefined
  }
  if (st.state !== 'done') return { state: 'running', ...base }
  if (st.ok) return { state: 'done', ...base }
  return { state: 'failed', ...base, error: (st.report?.errors ?? []).slice(0, 3).join('\n') || st.step }
}
