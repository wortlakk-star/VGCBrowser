import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin, type Plugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Máy chủ dữ liệu chọn lúc build (VGC_TARGET):
//   xeon (mặc định) — máy chủ riêng của công ty (sync.vgcbrowser.com);
//   fake            — máy chủ giả trên Xeon trong mạng nhà, CHỈ để thử (có nút chuyển dữ liệu).
// Cloud Supabase cũ đã huỷ hẳn 6/11/2026 — không còn target 'supabase'.
// VGC_APP_KEY: khoá riêng của app để qua cổng máy chủ công ty — truyền lúc build (bí mật CI),
// không bao giờ ghi vào repo. VGC_TEST=1: bản thử, dữ liệu để thư mục riêng, tên "VGC Browser TEST".
const TARGET = process.env.VGC_TARGET || 'xeon'
if (!['xeon', 'fake'].includes(TARGET)) throw new Error(`VGC_TARGET không hợp lệ: ${TARGET}`)
const APP_KEY = process.env.VGC_APP_KEY || ''
if (TARGET === 'xeon' && !/^[a-f0-9]{64}$/.test(APP_KEY)) throw new Error('Bản xeon cần VGC_APP_KEY (64 hex)')
const FAKE_ANON = process.env.VGC_FAKE_ANON || ''
const TEST = process.env.VGC_TEST === '1' || TARGET === 'fake'

const ORIGINS: Record<string, string> = {
  xeon: 'https://sync.vgcbrowser.com',
  fake: 'http://192.168.1.19:8200'
}
const define = {
  __VGC_TARGET__: JSON.stringify(TARGET),
  __VGC_APP_KEY__: JSON.stringify(APP_KEY),
  __VGC_FAKE_ANON__: JSON.stringify(FAKE_ANON),
  __VGC_TEST__: JSON.stringify(TEST)
}

/** CSP của trang chỉ cho kết nối tới đúng máy chủ của bản build này. */
function cspOrigins(): Plugin {
  const origin = ORIGINS[TARGET]
  const ws = origin.replace(/^http/, 'ws')
  return {
    name: 'vgc-csp-origins',
    transformIndexHtml: (html) => html.replaceAll('__VGC_CLOUD_ORIGINS__', `${origin} ${ws}`)
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define
  },
  renderer: {
    define,
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react(), cspOrigins()]
  }
})
