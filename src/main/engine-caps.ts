// ── VGC Browser — what the installed VGC Core engine can do ──────────────────
// The engine is a separately built Chromium; the app must not assume a capability the
// binary it is about to launch does not have. Capabilities are keyed on the engine
// BUILD number in the hosted zip name ("vgc-core-158.zip" → 158; Mac
// "vgc-core-mac-arm64-0.1.101.zip" → 0.1.101), read from the manifest the installer /
// downloader leaves next to the binary, falling back to the release-pinned URL.

import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AppSettings } from '../shared/types'

/** First engine build whose WebGPU adapter identity follows --vgc-webgl-* (patch
 *  vgc-webgpu-identity.patch). Older engines leak the real GPU through WebGPU, so the
 *  app disables WebGPU for them instead. */
const WEBGPU_IDENTITY_MIN_WIN_BUILD = 158
const WEBGPU_IDENTITY_MIN_MAC_VERSION = [0, 1, 101]

function manifestUrl(enginePath: string): string {
  try {
    const dir = dirname(enginePath)
    for (const candidate of [join(dir, '.vgc-engine.json'), join(dir, '..', 'mac-engine.json')]) {
      if (!existsSync(candidate)) continue
      const j = JSON.parse(readFileSync(candidate, 'utf8')) as { url?: unknown }
      if (typeof j.url === 'string') return j.url
    }
  } catch {
    // fall through to the release-pinned URL
  }
  return ''
}

/** Windows engine build number ("vgc-core-158.zip" → 158), 0 when unknown. */
export function engineBuildNumber(enginePath: string, settings: Pick<AppSettings, 'engineUrl'>): number {
  const url = manifestUrl(enginePath) || settings.engineUrl || ''
  const m = /vgc-core-(\d+)\.zip/i.exec(url)
  return m ? Number(m[1]) : 0
}

/** Mac engine version tuple ("…-0.1.101.zip" → [0,1,101]), [] when unknown. */
export function macEngineVersion(
  enginePath: string,
  settings: Pick<AppSettings, 'engineUrlMac'>
): number[] {
  const url = manifestUrl(enginePath) || settings.engineUrlMac || ''
  const m = /vgc-core-mac-[a-z0-9]+-(\d+)\.(\d+)\.(\d+)\.zip/i.exec(url)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : []
}

function versionAtLeast(v: number[], min: number[]): boolean {
  if (!v.length) return false
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0
    if (a > min[i]) return true
    if (a < min[i]) return false
  }
  return true
}

/**
 * Does this engine spoof navigator.gpu adapter info to match the claimed WebGL GPU?
 * A developer build pointed to by VGC_ENGINE_PATH is assumed current.
 */
export function engineHasWebGpuIdentity(
  enginePath: string,
  settings: Pick<AppSettings, 'engineUrl' | 'engineUrlMac'>
): boolean {
  if (process.env.VGC_ENGINE_PATH && enginePath === process.env.VGC_ENGINE_PATH) return true
  if (process.platform === 'win32') {
    return engineBuildNumber(enginePath, settings) >= WEBGPU_IDENTITY_MIN_WIN_BUILD
  }
  if (process.platform === 'darwin') {
    return versionAtLeast(macEngineVersion(enginePath, settings), WEBGPU_IDENTITY_MIN_MAC_VERSION)
  }
  return false
}
