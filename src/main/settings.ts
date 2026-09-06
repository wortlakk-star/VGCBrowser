// Encrypted local settings with release-controlled cloud and engine provenance.
import { app } from 'electron'
import { randomBytes } from 'crypto'
import { join } from 'path'
import type { AppSettings } from '../shared/types'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'

export type { AppSettings }

const ENGINE_MANIFEST = Object.freeze({
  windowsUrl: 'https://vgcbrowser.com/dl/vgc-core-159.zip',
  // Pinned SHA-256 for runtime downloads on Windows (from release artifact vgc-core-159.zip).
  windowsSha256: '1ccb4569f06ee62308344f7d4f101e67993b42027074b3549bc8ab19bd294112',
  macArm64Url: 'https://vgcbrowser.com/dl/vgc-core-mac-arm64-0.1.101.zip',
  // engine 0.1.101: vgc-webgpu-identity.patch (native WebGPU adapter identity, no real-GPU leak).
  macArm64Sha256: '19d90923f393f5f922c6438ca68af713b1e2ea593909c2065360b65a79ef616b'
})

const CLOUD_MANIFEST = Object.freeze({
  url: 'https://pwiledrttvbnmytghyip.supabase.co',
  anonKey: 'sb_publishable_nBbOnvIm-RnevH9CCux9Hg_pvPncobO'
})

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.enc')
}

function legacySettingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function makeToken(): string {
  return randomBytes(24).toString('hex')
}

function defaults(): AppSettings {
  return {
    apiEnabled: false,
    apiPort: 36912,
    apiToken: makeToken(),
    supabaseUrl: CLOUD_MANIFEST.url,
    supabaseAnonKey: CLOUD_MANIFEST.anonKey,
    engineUrl: ENGINE_MANIFEST.windowsUrl,
    engineHash: ENGINE_MANIFEST.windowsSha256,
    engineUrlMac: ENGINE_MANIFEST.macArm64Url,
    engineHashMac: ENGINE_MANIFEST.macArm64Sha256,
    useSystemBrowser: false,
    nativeMode: true,
    proxyKeepAlive: true
  }
}

function normalize(stored: Partial<AppSettings>): AppSettings {
  const d = defaults()
  const port = Number(stored.apiPort)
  return {
    apiEnabled: typeof stored.apiEnabled === 'boolean' ? stored.apiEnabled : d.apiEnabled,
    apiPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : d.apiPort,
    apiToken: /^[a-f0-9]{48}$/i.test(stored.apiToken ?? '') ? stored.apiToken! : d.apiToken,
    // Cloud and engine provenance are release metadata, never renderer-controlled settings.
    supabaseUrl: d.supabaseUrl,
    supabaseAnonKey: d.supabaseAnonKey,
    engineUrl: d.engineUrl,
    engineHash: d.engineHash,
    engineUrlMac: d.engineUrlMac,
    engineHashMac: d.engineHashMac,
    useSystemBrowser: false,
    nativeMode: true,
    proxyKeepAlive:
      typeof stored.proxyKeepAlive === 'boolean' ? stored.proxyKeepAlive : d.proxyKeepAlive,
    ...(typeof stored.capsolverApiKey === 'string' && stored.capsolverApiKey.length <= 4096
      ? { capsolverApiKey: stored.capsolverApiKey.trim() }
      : {})
  }
}

let cache: AppSettings | null = null
let loading: Promise<AppSettings> | null = null
let mutationChain: Promise<unknown> = Promise.resolve()

function serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn)
  mutationChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  if (loading) return loading
  loading = (async () => {
    const stored =
      (await readSecureJson<Partial<AppSettings>>(settingsFile())) ??
      (await migratePlainJson<Partial<AppSettings>>(settingsFile(), legacySettingsFile()))
    cache = normalize(stored ?? {})
    if (!stored) await writeSecureJson(settingsFile(), cache)
    return cache
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return serializeMutation(async () => {
    const current = await getSettings()
    const allowed: Partial<AppSettings> = {}
    if (typeof patch.apiEnabled === 'boolean') allowed.apiEnabled = patch.apiEnabled
    if (Number.isInteger(patch.apiPort) && patch.apiPort! >= 1024 && patch.apiPort! <= 65535) {
      allowed.apiPort = patch.apiPort
    }
    if (typeof patch.proxyKeepAlive === 'boolean') allowed.proxyKeepAlive = patch.proxyKeepAlive
    if (typeof patch.capsolverApiKey === 'string' && patch.capsolverApiKey.length <= 4096) {
      allowed.capsolverApiKey = patch.capsolverApiKey.trim()
    }

    const next = normalize({ ...current, ...allowed })
    await writeSecureJson(settingsFile(), next)
    cache = next
    return next
  })
}

export async function regenerateToken(): Promise<AppSettings> {
  return serializeMutation(async () => {
    const current = await getSettings()
    const next = normalize({ ...current, apiToken: makeToken() })
    await writeSecureJson(settingsFile(), next)
    cache = next
    return next
  })
}
