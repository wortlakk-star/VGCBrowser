// Vite config for the renderer UI preview (design work without Electron / Supabase).
// Build: npx vite build --config test/ui-preview/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  // Hằng build của electron.vite.config.ts — renderer tham chiếu, thiếu là trắng trang.
  define: { __VGC_TARGET__: '"xeon"', __VGC_APP_KEY__: '""', __VGC_FAKE_ANON__: '""', __VGC_TEST__: 'false' },
  build: { outDir: resolve(__dirname, 'dist'), emptyOutDir: true, sourcemap: false },
  logLevel: 'warn'
})
