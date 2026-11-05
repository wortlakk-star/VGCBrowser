// ── VGC Browser — chạy TRƯỚC mọi module khác (import đầu tiên trong index.ts) ─────
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'fs'
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

// ── Bản máy chủ công ty (2.2.0): lần mở ĐẦU TIÊN XOÁ HẲN mọi dữ liệu thời cloud trên máy, rồi tải lại
// sạch từ máy chủ công ty (100% dữ liệu đồng bộ nằm ở đó). Giữ: engine, cài đặt, mã máy, khoá mã hoá
// tài khoản (acct-secret / cloud-passphrase — cùng một khoá trên máy chủ, nên không phải nhập lại
// passphrase), danh sách nhóm, khoá API nhà cung cấp proxy, cấu hình khoá profile (tự gộp với máy chủ).
const FRESH_FLAG = 'company-fresh-start.flag'
function freshStartFromCompanyServer(): void {
  const root = app.getPath('userData')
  try {
    if (!existsSync(root)) return
    const rm = (rel: string): void => rmSync(join(root, rel), { recursive: true, force: true, maxRetries: 3 })
    // Bản thử trước có thể đã cất dữ liệu cũ ra đây — xoá luôn.
    for (const name of readdirSync(root)) if (name.startsWith('old-cloud-data-')) rm(name)
    if (existsSync(join(root, FRESH_FLAG))) return
    for (const rel of ['profiles', 'sync-meta', 'sync-staging', 'passkey-backups', 'cloud-auth.enc', 'vgc-license.enc', 'vgc-license.json']) rm(rel)
    for (const name of readdirSync(root)) if (/^etag-remapped-.*\.flag$/.test(name)) rm(name)
    const db = join(root, 'db')
    if (existsSync(db)) for (const name of readdirSync(db)) if (/^(profiles|proxies)-.*\.(enc|json)$|^proxies\.json$/.test(name)) rm(join('db', name))
    writeFileSync(join(root, FRESH_FLAG), new Date().toISOString(), { mode: 0o600 })
  } catch (e) {
    // Không chặn app; lần sau thử lại (chưa ghi cờ).
    console.error('[company] fresh start failed', e)
  }
}
if (CLOUD_TARGET === 'xeon') freshStartFromCompanyServer()
