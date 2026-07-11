// ── VGC Browser — app settings ───────────────────────────────────────────────
// Small JSON-backed settings store (userData/settings.json). Holds the local
// automation API config + token. Cached in memory; written on change.

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AppSettings } from '../shared/types'

export type { AppSettings }

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function makeToken(): string {
  return randomBytes(24).toString('hex')
}

function defaults(): AppSettings {
  return {
    apiEnabled: true,
    apiPort: 36912,
    apiToken: makeToken(),
    supabaseUrl: 'https://pwiledrttvbnmytghyip.supabase.co',
    supabaseAnonKey: 'sb_publishable_nBbOnvIm-RnevH9CCux9Hg_pvPncobO',
    engineUrl: 'https://vgcbrowser.com/dl/vgc-core-151.zip',
    // macOS VGC Core engine (built + packaged by scripts/package-mac-engine.sh,
    // hosted on vgcbrowser.com/dl). Other Macs auto-download it on first launch;
    // the build machine uses its local userData/engine/VGC Core.app regardless.
    engineUrlMac: 'https://vgcbrowser.com/dl/vgc-core-mac-arm64-0.1.102.zip',
    // SHA-256 of the engine zip above — verified after download so a compromised host
    // or a MITM can't swap in a malicious engine (the zip is executed as the browser).
    engineHashMac: '51b8837314e8d9b5af71e824a7551ba92d00744dd78a94c6fe60672e91e203ee',
    // GoLogin-style: native engine spoofing, NO CDP debugger → Google sign-in works.
    nativeMode: true
  }
}

let cache: AppSettings | null = null

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(settingsFile(), 'utf-8')
    const d = defaults()
    cache = { ...d, ...(JSON.parse(raw) as Partial<AppSettings>) }
    // A persisted EMPTY engine URL must not defeat a newer non-empty default
    // (the spread above would keep ''). Coalesce empties back to the default so a
    // machine that once saved '' still picks up the now-hosted engine.
    if (!cache.engineUrl) cache.engineUrl = d.engineUrl
    if (!cache.engineUrlMac) cache.engineUrlMac = d.engineUrlMac
  } catch {
    cache = defaults()
    await fs.writeFile(settingsFile(), JSON.stringify(cache, null, 2), 'utf-8')
  }
  return cache
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings()
  cache = { ...current, ...patch }
  await fs.writeFile(settingsFile(), JSON.stringify(cache, null, 2), 'utf-8')
  return cache
}

export async function regenerateToken(): Promise<AppSettings> {
  return saveSettings({ apiToken: makeToken() })
}
