// ── VGC Browser — chạy TRƯỚC mọi module khác (import đầu tiên trong index.ts) ─────
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { CLOUD_TARGET, IS_TEST_BUILD, headersFor } from './targets'

// Bản thử dùng thư mục dữ liệu riêng → không bao giờ đọc/ghi profile của bản thật trên máy.
if (IS_TEST_BUILD) {
  app.setName('VGC Browser TEST')
  app.setPath('userData', join(app.getPath('appData'), CLOUD_TARGET === 'fake' ? 'vgc-browser-test' : `vgc-browser-test-${CLOUD_TARGET}`))
}

// Mọi lệnh gọi máy chủ công ty đều mang khoá app (cổng vgc-gate trả 404 nếu thiếu). Bọc fetch một
// chỗ để không lệnh nào bị sót; URL khác giữ nguyên.
const baseFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const extra = headersFor(url)
  if (!Object.keys(extra).length) return baseFetch(input, init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  return baseFetch(input, { ...init, headers })
}) as typeof fetch

// ── Bản máy chủ công ty (2.2.0): lần mở ĐẦU TIÊN bỏ hết dữ liệu thời cloud trên máy, tải lại sạch
// từ máy chủ công ty. Giữ: engine, cài đặt, mã máy, khoá mã hoá tài khoản (acct-secret / cloud-
// passphrase — dùng chung cho cloud và máy chủ, nên không phải nhập lại passphrase), danh sách nhóm,
// khoá API nhà cung cấp proxy, cấu hình khoá profile (tự gộp với máy chủ). Dữ liệu cũ được CẤT vào
// old-cloud-data-<thời điểm>/ (đề phòng) và tự xoá sau 7 ngày.
const FRESH_FLAG = 'company-fresh-start.flag'
const KEEP_OLD_MS = 7 * 24 * 60 * 60 * 1000
function freshStartFromCompanyServer(): void {
  const root = app.getPath('userData')
  const flag = join(root, FRESH_FLAG)
  try {
    if (existsSync(flag)) {
      for (const name of readdirSync(root)) {
        if (!name.startsWith('old-cloud-data-')) continue
        const p = join(root, name)
        if (Date.now() - statSync(p).mtimeMs > KEEP_OLD_MS) rmSync(p, { recursive: true, force: true })
      }
      return
    }
    if (!existsSync(root)) return // máy mới tinh: không có gì để bỏ
    const bak = join(root, `old-cloud-data-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(bak, { recursive: true, mode: 0o700 })
    const move = (rel: string): void => {
      const from = join(root, rel)
      if (!existsSync(from)) return
      const to = join(bak, rel)
      mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 })
      renameSync(from, to)
    }
    for (const rel of ['profiles', 'sync-meta', 'sync-staging', 'passkey-backups', 'cloud-auth.enc', 'vgc-license.enc', 'vgc-license.json']) move(rel)
    for (const name of readdirSync(root)) if (/^etag-remapped-.*\.flag$/.test(name)) move(name)
    const db = join(root, 'db')
    if (existsSync(db)) for (const name of readdirSync(db)) if (/^(profiles|proxies)-.*\.(enc|json)$|^proxies\.json$/.test(name)) move(join('db', name))
    writeFileSync(flag, new Date().toISOString(), { mode: 0o600 })
  } catch (e) {
    // Không chặn app; lần sau thử lại (chưa ghi cờ).
    console.error('[company] fresh start failed', e)
  }
}
if (CLOUD_TARGET === 'xeon') freshStartFromCompanyServer()
