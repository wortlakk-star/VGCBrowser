/// <reference types="vite/client" />
import type { VgcApi } from '../preload'

declare global {
  interface Window {
    vgc: VgcApi
  }
}

export {}
