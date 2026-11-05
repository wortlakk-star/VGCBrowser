// ── VGC Browser — máy chủ dữ liệu của bản build này ──────────────────────────
// Chọn lúc build bằng VGC_TARGET (xem electron.vite.config.ts). Mọi URL cloud, khoá công khai,
// trang duyệt nhân viên và đích "chuyển dữ liệu" đều lấy từ đây — không chỗ nào khác tự ghi URL.

export type CloudTarget = 'supabase' | 'xeon' | 'fake'

// Giữ dạng biểu thức hằng (không qua hàm) để Rollup bỏ được nhánh không dùng.
const __TARGET: CloudTarget = (typeof __VGC_TARGET__ !== 'undefined' ? __VGC_TARGET__ : 'supabase') as CloudTarget
const target: CloudTarget = __TARGET
const appKey = typeof __VGC_APP_KEY__ !== 'undefined' ? __VGC_APP_KEY__ : ''
const fakeAnon = typeof __VGC_FAKE_ANON__ !== 'undefined' ? __VGC_FAKE_ANON__ : ''

export const CLOUD_TARGET: CloudTarget = target
/** Bản thử: tên "VGC Browser TEST", dữ liệu ở thư mục riêng — không đụng bản thật trên máy. */
export const IS_TEST_BUILD = typeof __VGC_TEST__ !== 'undefined' ? __VGC_TEST__ === true : false

/** Máy chủ công ty (Xeon, qua Cloudflare Tunnel + cổng kiểm tra khoá app). */
export const COMPANY_SERVER = Object.freeze({
  url: 'https://sync.vgcbrowser.com',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkzOTA1NDU3LCJleHAiOjE5NTE1ODU0NTd9.tqk6gAYZ-OUViYbx8r_0NhCoNcn9mS-TFdn1yUnYxJ8',
  headers: appKey ? Object.freeze({ 'X-VGC-Key': appKey }) : Object.freeze({})
})

// Chỉ nhánh của ĐÚNG bản build được đóng vào app (Rollup bỏ nhánh còn lại vì __VGC_TARGET__ là hằng):
// bản xeon không chứa địa chỉ / khoá Supabase cloud, trang /quanly cũ hay chức năng chuyển dữ liệu.

/** Máy chủ dữ liệu app đang dùng (đăng nhập, profile, kho file). */
export const CLOUD: { url: string; anonKey: string; headers: Record<string, string> } =
  __TARGET === 'xeon'
    ? { url: COMPANY_SERVER.url, anonKey: COMPANY_SERVER.anonKey, headers: { ...COMPANY_SERVER.headers } }
    : __TARGET === 'fake'
      ? { url: 'http://192.168.1.19:8200', anonKey: fakeAnon, headers: {} }
      : { url: 'https://pwiledrttvbnmytghyip.supabase.co', anonKey: 'sb_publishable_nBbOnvIm-RnevH9CCux9Hg_pvPncobO', headers: {} }

/** Danh sách nhân viên được dùng: máy chủ công ty, hoặc trang cũ trên Hostinger (chỉ bản cloud). */
export const LICENSE: { check: string; register: string; headers: Record<string, string> } =
  __TARGET === 'supabase'
    ? { check: 'https://vgcbrowser.com/quanly/check.php', register: 'https://vgcbrowser.com/quanly/register.php', headers: {} }
    : { check: `${COMPANY_SERVER.url}/vgc/v1/license/check`, register: `${COMPANY_SERVER.url}/vgc/v1/license/register`, headers: { ...COMPANY_SERVER.headers } }

/** Đích của nút "Chuyển dữ liệu sang máy chủ công ty" — chỉ có ở bản còn chạy trên cloud. */
export const MIGRATION: { url: string; headers: Record<string, string> } | null =
  __TARGET !== 'xeon' && appKey ? { url: `${COMPANY_SERVER.url}/vgc/v1/migrate`, headers: { ...COMPANY_SERVER.headers } } : null

/** Header phải gắn cho một URL (khoá app khi gọi máy chủ công ty). */
export function headersFor(url: string): Record<string, string> {
  return appKey && url.startsWith(`${COMPANY_SERVER.url}/`) ? { 'X-VGC-Key': appKey } : {}
}
