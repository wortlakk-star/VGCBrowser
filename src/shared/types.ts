// ── VGC Browser — shared domain types ────────────────────────────────────────
// These types are used across main, preload and renderer. Keep them runtime-agnostic
// (no Node or DOM imports) so every layer can share them safely.

export type OsType = 'windows' | 'macos' | 'linux' | 'android'

export type ProxyType = 'none' | 'http' | 'https' | 'socks5'

export interface ProxyConfig {
  type: ProxyType
  host?: string
  port?: number
  username?: string
  password?: string
  /** Optional: provider/label for proxies bought inside the app (Phase 3). */
  provider?: string
}

/**
 * A browser fingerprint. Every field here is something a real antidetect engine
 * must make consistent — e.g. userAgent ⇄ uaFullVersion ⇄ webgl ⇄ timezone must
 * all agree, or detectors flag the mismatch. In Phase 0 we store the values; in
 * Phase 1 we inject them (CDP) and later (Phase 5) at the C++ engine level.
 */
export interface Fingerprint {
  // ── Navigator ──
  userAgent: string
  platform: string // 'Win32' | 'MacIntel' | 'Linux x86_64'
  language: string // primary, e.g. 'en-US'
  languages: string[] // navigator.languages
  hardwareConcurrency: number // logical cores reported
  deviceMemory: number // GB: 4 | 8 | 16
  vendor: string // 'Google Inc.'

  // ── Screen ──
  screen: {
    width: number
    height: number
    colorDepth: number
    pixelDepth: number
  }
  devicePixelRatio: number

  // ── WebGL (UNMASKED vendor/renderer — high-signal for detectors) ──
  webgl: {
    vendor: string
    renderer: string
  }

  // ── Noise toggles (consistent per-profile noise on readback) ──
  canvasNoise: boolean
  audioNoise: boolean
  clientRectsNoise: boolean

  // ── WebRTC handling ──
  // 'disabled'  → block WebRTC entirely
  // 'proxy'     → spoof local/public IP to match the proxy (recommended)
  // 'real'      → leak real IP (NOT recommended)
  webrtc: 'disabled' | 'proxy' | 'real'

  // ── Timezone / Geo (must match proxy IP location) ──
  timezone: string // IANA, e.g. 'America/New_York'
  geolocation?: {
    latitude: number
    longitude: number
    accuracy: number
  }

  // ── Client Hints (modern Chrome — Sec-CH-UA family) ──
  uaFullVersion: string // e.g. '126.0.6478.127'
  uaPlatformVersion: string // e.g. '15.0.0'

  // ── Fonts the page is allowed to detect ──
  fonts: string[]

  // ── WebRTC: when set (from proxy check), only this public IP is allowed
  //    through WebRTC, hiding the real one. ──
  webrtcPublicIp?: string

  // ── Misc ──
  doNotTrack: '0' | '1' | 'unset'
}

/** A browser cookie (import/export format, aligned with CDP Network.Cookie). */
export interface Cookie {
  name: string
  value: string
  domain: string
  path?: string
  expires?: number // unix seconds
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface Profile {
  id: string
  name: string
  notes: string
  tags: string[]
  group?: string
  os: OsType
  fingerprint: Fingerprint
  proxy: ProxyConfig
  startUrls: string[]
  /** Cookies imported into the profile; applied via CDP before first navigation. */
  cookies?: Cookie[]
  /** Unpacked Chrome extension folder paths to load into the profile. */
  extensions?: string[]
  /** Cloud team this profile is shared to (Phase 6c). Empty = personal. */
  cloudTeamId?: string
  /** ISO time the profile's browser DATA (cookies/session) was last uploaded to
   *  cloud storage. Set ⇒ this profile has session data in the cloud bucket. */
  cloudDataAt?: string
  /** Result of the automatic proxy check run each time the profile is opened. */
  proxyCheck?: {
    status: 'ok' | 'error'
    ip?: string
    country?: string
    countryCode?: string
    latencyMs?: number
    at: string // ISO
  }
  createdAt: string // ISO
  updatedAt: string // ISO
  lastUsedAt?: string // ISO
}

/** Supported proxy providers with an API/gateway connector. */
export type ProxyProviderId = 'iproyal' | 'oxylabs' | 'brightdata'

/** Stored account credentials for proxy providers (per cloud account). */
export interface ProviderCreds {
  iproyal?: { username: string; password: string }
  oxylabs?: { username: string; password: string }
  brightdata?: { customer: string; zone: string; password: string }
}

/** Options for building a provider proxy connection string. */
export interface ProxyBuildOpts {
  country?: string // ISO-2, e.g. 'us', 'vn' (empty = any)
  sticky?: boolean // keep the same IP for a session vs rotating
  sessionMinutes?: number // sticky session lifetime
}

/** A reusable proxy saved in the Proxy Manager. */
export interface SavedProxy {
  id: string
  label: string
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
  /** Pool metadata: which profile this proxy is assigned to (id), + last check. */
  assignedTo?: string
  lastIp?: string
  lastCountry?: string
  lastCountryCode?: string
  latencyMs?: number
  lastStatus?: 'ok' | 'error'
}

/** App-level settings (automation API + cloud config). */
export interface AppSettings {
  apiEnabled: boolean
  apiPort: number
  apiToken: string
  /** Supabase project URL + anon key for Cloud/Team (Phase 6). */
  supabaseUrl: string
  supabaseAnonKey: string
  /** URL of the VGC Core engine .zip on the server; downloaded on first run. */
  engineUrl: string
  /** URL of the macOS VGC Core engine .zip (a built Chromium .app); downloaded on
   *  first run on Mac. Empty → fall back to the system Chrome. */
  engineUrlMac?: string
}

/** State of the app auto-update flow (check → download → install). */
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'dev'
  /** Version currently running. */
  currentVersion: string
  /** Version available/downloaded on the server (when newer). */
  newVersion?: string
  /** Download progress 0–100 (during 'downloading'). */
  percent?: number
  /** Human message (errors / dev note). */
  message?: string
  /**
   * When set (macOS only), auto-install isn't possible — the app isn't code-signed
   * with an Apple Developer ID, so the user must download + install manually. The UI
   * shows a "Tải về" button that opens this URL instead of "Khởi động lại".
   */
  manualDownloadUrl?: string
}

/** Progress of the on-demand engine download. */
export interface EngineProgress {
  id?: string
  phase: 'check' | 'download' | 'extract' | 'done' | 'error'
  percent?: number
  message?: string
}

/** Result of probing a proxy (IP, geo, timezone). */
export interface ProxyCheckResult {
  ok: boolean
  ip?: string
  country?: string
  countryCode?: string
  city?: string
  timezone?: string
  latitude?: number
  longitude?: number
  latencyMs?: number
  error?: string
}

/** Cloud auth session handed from renderer (supabase-js) to main for Storage ops. */
export interface CloudSession {
  accessToken: string
  uid: string
}

/** Progress of syncing a profile's browser data (user-data-dir) to/from cloud. */
export interface DataSyncState {
  id: string
  phase: 'zip' | 'upload' | 'download' | 'extract' | 'done' | 'error'
  message?: string
}

export type ProfileStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface ProfileRuntimeState {
  id: string
  status: ProfileStatus
  pid?: number
  debugPort?: number
  startedAt?: string
  error?: string
}

/** Shape accepted by the create-profile IPC; everything optional, sensible defaults applied. */
export type CreateProfileInput = Partial<
  Pick<Profile, 'name' | 'notes' | 'tags' | 'group' | 'os' | 'fingerprint' | 'proxy' | 'startUrls'>
>
