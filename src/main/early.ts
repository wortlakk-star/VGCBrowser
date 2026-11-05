// ── VGC Browser — chạy TRƯỚC mọi module khác (import đầu tiên trong index.ts) ─────
import { app } from 'electron'
import { join } from 'path'
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
