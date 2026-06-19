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
    engineUrl: 'https://vgcbrowser.com/dl/vgc-core-149.zip',
    // Set once the macOS VGC Core engine is hosted (scripts/package-mac-engine.sh →
    // upload). Empty → other Macs fall back to system Chrome; the build machine uses
    // its local userData/engine/VGC Core.app regardless.
    engineUrlMac: ''
  }
}

let cache: AppSettings | null = null

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(settingsFile(), 'utf-8')
    cache = { ...defaults(), ...(JSON.parse(raw) as Partial<AppSettings>) }
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
