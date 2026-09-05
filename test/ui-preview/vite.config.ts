// Vite config for the renderer UI preview (design work without Electron / Supabase).
// Build: npx vite build --config test/ui-preview/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: { outDir: resolve(__dirname, 'dist'), emptyOutDir: true, sourcemap: false },
  logLevel: 'warn'
})
