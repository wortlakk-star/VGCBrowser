import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: { outDir: resolve(__dirname, 'dist-old'), emptyOutDir: true, sourcemap: false, rollupOptions: { input: resolve(__dirname, 'index-old.html') } },
  logLevel: 'warn'
})
