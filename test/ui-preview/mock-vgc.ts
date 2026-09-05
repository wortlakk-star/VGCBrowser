// A stand-in for the preload bridge (window.vgc) so the renderer can run in a plain browser
// for design work. Every method resolves with plausible data; subscriptions return no-op
// unsubscribers. Nothing here talks to the network.
import type {
  Profile,
  ProfileRuntimeState,
  SavedProxy,
  AppSettings,
  Fingerprint
} from '../../src/shared/types'

const now = Date.now()
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString()

function fp(ua: string, platform: string, tz: string): Fingerprint {
  return {
    userAgent: ua,
    platform,
    language: 'vi-VN',
    languages: ['vi-VN', 'vi', 'en-US'],
    timezone: tz,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA GeForce RTX 3060)' },
    webrtc: 'proxy',
    geolocation: { latitude: 10.8, longitude: 106.7, accuracy: 100 }
  } as unknown as Fingerprint
}

const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

interface Seed {
  name: string
  group?: string
  os: 'windows' | 'macos'
  status?: 'live' | 'ready' | 'die' | 'banned'
  proxy?: { host: string; cc: string; ip: string; ms: number; ok?: boolean }
  user?: string
  tags?: string[]
  lastUsed?: number
}

const SEEDS: Seed[] = [
  { name: 'FB Ads — Nguyễn Minh', group: 'Facebook Ads', os: 'windows', status: 'live', proxy: { host: 'us.evomi.com', cc: 'US', ip: '104.28.212.19', ms: 142 }, user: 'minh.nguyen@gmail.com', tags: ['ads', 'vip'], lastUsed: 4 * 60_000 },
  { name: 'FB Ads — Trần Hà', group: 'Facebook Ads', os: 'windows', status: 'live', proxy: { host: 'us.evomi.com', cc: 'US', ip: '172.58.94.201', ms: 168 }, user: 'ha.tran@gmail.com', tags: ['ads'], lastUsed: 31 * 60_000 },
  { name: 'Gmail farm 07', group: 'Gmail', os: 'windows', status: 'ready', proxy: { host: 'gate.iproyal.com', cc: 'VN', ip: '14.241.120.55', ms: 38 }, user: 'farm07.vgc@gmail.com', lastUsed: 2 * 3_600_000 },
  { name: 'Gmail farm 08', group: 'Gmail', os: 'windows', status: 'ready', proxy: { host: 'gate.iproyal.com', cc: 'VN', ip: '14.241.120.71', ms: 41 }, user: 'farm08.vgc@gmail.com', lastUsed: 2 * 3_600_000 },
  { name: 'TikTok Shop — Linh', group: 'TikTok', os: 'macos', status: 'live', proxy: { host: 'sg.cliproxy.io', cc: 'SG', ip: '103.6.151.88', ms: 64 }, user: 'linh.shop@outlook.com', tags: ['shop'], lastUsed: 26 * 3_600_000 },
  { name: 'Amazon seller US-2', group: 'Amazon', os: 'windows', status: 'die', proxy: { host: 'us.evomi.com', cc: 'US', ip: '—', ms: 0, ok: false }, user: 'seller.us2@proton.me', lastUsed: 3 * 86_400_000 },
  { name: 'Etsy — Palcle', group: 'Amazon', os: 'windows', status: 'live', proxy: { host: 'gate.iproyal.com', cc: 'DE', ip: '91.229.23.140', ms: 203 }, user: 'palcle@etsy.com', tags: ['etsy'], lastUsed: 5 * 86_400_000 },
  { name: 'Test profile', os: 'windows', lastUsed: 9 * 86_400_000 },
  { name: 'Google Ads — Agency', group: 'Google', os: 'macos', status: 'banned', proxy: { host: 'us.evomi.com', cc: 'US', ip: '66.249.70.12', ms: 155 }, user: 'agency.ads@gmail.com', lastUsed: 12 * 86_400_000 },
  { name: 'Shopee KOL 01', group: 'TikTok', os: 'windows', status: 'ready', proxy: { host: 'vn.cliproxy.io', cc: 'VN', ip: '113.161.72.9', ms: 22 }, user: 'kol01@gmail.com', lastUsed: 20 * 86_400_000 }
]

const profiles: Profile[] = SEEDS.map((s, i) => ({
  id: `0000000${i}-1111-4222-8333-44444444444${i}`.slice(0, 36),
  name: s.name,
  notes: '',
  tags: s.tags ?? [],
  group: s.group,
  os: s.os,
  fingerprint: fp(s.os === 'macos' ? MAC_UA : WIN_UA, s.os === 'macos' ? 'MacIntel' : 'Win32', 'America/New_York'),
  proxy: s.proxy
    ? { type: 'http', host: s.proxy.host, port: 8000, username: 'user', password: 'pass' }
    : { type: 'none', host: '', port: 0 },
  startUrls: [],
  proxyCheck: s.proxy
    ? s.proxy.ok === false
      ? { status: 'error', at: iso(60_000) }
      : { status: 'ok', ip: s.proxy.ip, countryCode: s.proxy.cc, country: s.proxy.cc, latencyMs: s.proxy.ms, at: iso(60_000) }
    : undefined,
  account: s.user ? { user: s.user, status: s.status, totp: i % 3 === 0 ? 'JBSWY3DPEHPK3PXP' : undefined } : undefined,
  createdAt: iso(30 * 86_400_000),
  updatedAt: iso(s.lastUsed ?? 0),
  lastUsedAt: s.lastUsed ? iso(s.lastUsed) : undefined,
  cloudDataAt: i % 2 === 0 ? iso(s.lastUsed ?? 0) : undefined
})) as Profile[]

const runtime: ProfileRuntimeState[] = profiles.map((p, i) => ({
  id: p.id,
  status: i === 0 || i === 4 ? 'running' : i === 5 ? 'error' : 'stopped',
  pid: i === 0 ? 4412 : undefined,
  error: i === 5 ? 'Proxy không phản hồi' : undefined
}))

const proxies: SavedProxy[] = SEEDS.filter((s) => s.proxy).map((s, i) => ({
  id: `p${i}`,
  label: `${s.proxy!.cc} · ${s.proxy!.host}`,
  type: 'http',
  host: s.proxy!.host,
  port: 8000,
  username: 'user',
  password: 'pass',
  lastIp: s.proxy!.ip,
  lastCountryCode: s.proxy!.cc,
  latencyMs: s.proxy!.ms,
  lastStatus: s.proxy!.ok === false ? 'error' : 'ok'
}))

const settings: AppSettings = {
  apiEnabled: false,
  apiPort: 36912,
  apiToken: 'preview-token',
  supabaseUrl: '',
  supabaseAnonKey: '',
  nativeMode: true
} as unknown as AppSettings

const noop = (): void => {}
const sub = (): (() => void) => noop

// Subscriptions the screenshot script can fire from the page (window.__emit.dataSync(...)).
type Listener = (payload: unknown) => void
const listeners: Record<string, Listener[]> = { dataSync: [], status: [], engine: [] }
const subscribe =
  (key: keyof typeof listeners) =>
  (cb: Listener): (() => void) => {
    listeners[key].push(cb)
    return () => {
      listeners[key] = listeners[key].filter((x) => x !== cb)
    }
  }
;(window as unknown as { __emit: unknown }).__emit = {
  dataSync: (p: unknown) => listeners.dataSync.forEach((cb) => cb(p)),
  status: (p: unknown) => listeners.status.forEach((cb) => cb(p)),
  engine: (p: unknown) => listeners.engine.forEach((cb) => cb(p))
}

/** Build the mock; unknown methods resolve to null so new bridge calls never crash the preview. */
export function createMockVgc(): Record<string, unknown> {
  const impl: Record<string, unknown> = {
    listProfiles: async () => profiles,
    runtimeStates: async () => runtime,
    listGroups: async () => ['Facebook Ads', 'Gmail', 'TikTok', 'Amazon', 'Google'],
    listProxies: async () => proxies,
    getSettings: async () => settings,
    saveSettings: async (patch: Partial<AppSettings>) => ({ ...settings, ...patch }),
    getVersion: async () => '2.1.72',
    versionGate: async () => ({ blocked: false, current: '2.1.72', min: '2.1.0', downloadUrl: '' }),
    getUpdateStatus: async () => ({ phase: 'idle' }),
    engineInstalled: async () => true,
    cloudEncryptionStatus: async () => ({ configured: true, unlocked: true }),
    cloudSetSession: async () => true,
    cloudAuthGet: async () => null,
    getWarmSchedule: async () => ({ enabled: false, profileIds: [], everyHours: 12, minutes: 2 }),
    totpNow: async () => '123 456',
    launchProfile: async (id: string) => ({ id, status: 'running' }),
    stopProfile: async () => undefined,
    onStatus: subscribe('status'),
    onDataSync: subscribe('dataSync'),
    onEngineProgress: subscribe('engine'),
    onUpdateStatus: sub,
    onGmailProgress: sub
  }
  return new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return async () => null
    }
  })
}
