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

/** One saved website login (Chrome "Login Data" → `logins` row), with the password
 *  DECRYPTED. Synced cross-machine as plaintext (then account-secret-encrypted in the
 *  cloud, exactly like cookies) so passwords survive machines with different
 *  machine-bound os_crypt keys. Re-encrypted with the LOCAL key when written back
 *  into a profile's Login Data. */
export interface SavedLogin {
  origin_url: string
  signon_realm: string
  password: string // DECRYPTED plaintext (never leaves the machine unencrypted)
  action_url?: string | null
  username_element?: string | null
  username_value?: string | null
  password_element?: string | null
  scheme?: number
  date_created?: number // Chrome epoch (µs since 1601) — kept so newer wins on merge
  date_password_modified?: number
  times_used?: number
  blacklisted_by_user?: number
}

/** One row of Chrome's `Network/Cookies` SQLite `cookies` table, with the value
 *  DECRYPTED. Synced cross-machine (account-secret-encrypted in the cloud) so login
 *  SESSIONS survive Win<->Mac where the engines use different os_crypt keys — same
 *  reason as [[SavedLogin]]. Carries every column generically so it adapts to the
 *  target's cookie-DB version; `value` is the decrypted plaintext, written back with an
 *  EMPTY encrypted_value so the target Chrome accepts it (and re-seals with its key). */
export interface SavedCookie {
  value: string // DECRYPTED plaintext value (SHA256-domain prefix already stripped)
  cols: Record<string, string | number> // all cookie columns EXCEPT value/encrypted_value
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

/** Health/state of the account a profile farms. '' / undefined = chưa đặt. */
export type AccountStatus = 'live' | 'die' | 'banned' | 'ready'

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
  /** Account this profile logs into — for farming/tracking (login creds + 2FA + health). */
  account?: {
    user?: string // email / username
    pass?: string
    totp?: string // 2FA secret (base32) — the app shows the current 6-digit code
    status?: AccountStatus
  }
  createdAt: string // ISO
  updatedAt: string // ISO
  lastUsedAt?: string // ISO
}

/** Supported proxy providers with an API/gateway connector. */
export type ProxyProviderId = 'iproyal' | 'oxylabs' | 'brightdata' | 'evomi' | 'cliproxy'

/** Stored account credentials for proxy providers (per cloud account). */
export interface ProviderCreds {
  // iProyal: username/password are the residential gateway login; apiToken (from
  // dashboard.iproyal.com → Settings → API) enables generating proxies via the API.
  iproyal?: { username: string; password: string; apiToken?: string }
  oxylabs?: { username: string; password: string }
  brightdata?: { customer: string; zone: string; password: string }
  // Evomi: a single API key (my.evomi.com → Settings → API) is enough — the public
  // API returns the per-product username/password/balance and formats ready-to-use
  // proxies, so no separate gateway login is stored.
  evomi?: { apiKey: string }
  // Cliproxy: a gateway provider (no REST API) — the session/country/sticky are encoded
  // in the username, so we store the gateway host+port and the account username/password
  // (all shown in dash.cliproxy.com). state is an optional default region/state.
  cliproxy?: { host?: string; port?: number; username: string; password: string; state?: string }
}

/** Options for building a provider proxy connection string. */
export interface ProxyBuildOpts {
  country?: string // ISO-2, e.g. 'us', 'vn' (empty = any)
  sticky?: boolean // keep the same IP for a session vs rotating
  sessionMinutes?: number // sticky session lifetime
}

/** Options for generating proxies on demand via a provider's API. */
export interface GenerateProxiesOpts {
  count: number // how many proxies to create (1–100)
  country?: string // ISO-2, e.g. 'us', 'vn' (empty = any/global)
  protocol: 'http' | 'socks5' // proxy protocol
  sticky: boolean // sticky (same IP for a lifetime) vs rotating (new IP each request)
  // iProyal sticky lifetime, already in the API's accepted format (seconds/hours,
  // e.g. '1800s', '24h', '168h' = 7 days). Empty ⇒ omit (default sticky). iProyal
  // rejects the minutes unit ('30m' → failed_validation), so the UI only emits s/h.
  // Evomi accepts the same string and converts it to minutes (max 1440).
  lifetime?: string
  label?: string // optional name prefix for the created proxies
  // Which provider to generate from. Default 'iproyal' (back-compat with old callers).
  provider?: ProxyProviderId
  // Evomi product code: 'rpc' (Core Residential) | 'rp' (Premium Residential) |
  // 'mp' (Mobile). Ignored by other providers.
  product?: string
  // Evomi "hard" session: keep the same IP as long as it stays connected (longer than
  // the 24h sticky cap). Overrides sticky/lifetime. Evomi only.
  hard?: boolean
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
  /** ISO — last local modification. Lets the cloud pull keep a local edit (assign/
   *  rename) that hasn't been pushed yet instead of overwriting it with a stale copy. */
  updatedAt?: string
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
  /** Pinned SHA-256 for the Windows engine archive. Empty disables runtime download. */
  engineHash?: string
  /** URL of the macOS VGC Core engine .zip (a built Chromium .app); downloaded on
   *  first run on Mac. Empty → fall back to the system Chrome. */
  engineUrlMac?: string
  engineHashMac?: string
  /** Legacy setting retained for migration. Production always requires VGC Core because
   *  stock Chrome ignores the native --vgc-* switches and creates a mixed fingerprint. */
  useSystemBrowser?: boolean
  /** GoLogin-style native mode (default ON): open profiles with the engine's own C++
   *  fingerprint spoofing and DO NOT attach a CDP debugger. Google blocks browsers with
   *  an active CDP session at sign-in, so this makes Google login work while keeping the
   *  native antidetect. Turning it OFF restores CDP injection (extra UA/timezone/JS
   *  spoofing + tab-sync + the automation API) but Google sign-in will be blocked. */
  nativeMode?: boolean
  /** Keep residential (Evomi hardsession) proxy IPs from rotating on inactivity: a
   *  background service opens a lightweight connection through each saved proxy every
   *  couple of minutes so the sticky session stays "connected" and the IP is held as long
   *  as the underlying peer is online. Connect-only (≈no payload) so it barely uses GB.
   *  Default ON. It can't beat a peer physically going offline — only ISP Static can. */
  proxyKeepAlive?: boolean
  /** CapSolver API key (capsolver.com) — when set, the bulk Gmail password tool
   *  auto-solves image captchas (and best-effort reCAPTCHA) it hits during the flow. */
  capsolverApiKey?: string
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
  startedAt?: string
  error?: string
}

/** Shape accepted by the create-profile IPC; everything optional, sensible defaults applied. */
export type CreateProfileInput = Partial<
  Pick<
    Profile,
    'name' | 'notes' | 'tags' | 'group' | 'os' | 'fingerprint' | 'proxy' | 'startUrls' | 'account'
  >
>

// ── Gmail bulk password-change tool ──────────────────────────────────────────
/** One account to process: change `oldPassword` → `newPassword` for `email`.
 *  `totpSecret` (optional) is the base32 2FA KEY (not a 6-digit code) — when present
 *  the tool auto-generates the current Authenticator code for Google's 2-step prompt. */
export interface GmailPasswordTask {
  email: string
  oldPassword: string
  newPassword: string
  totpSecret?: string
}

export type GmailChangeStatus =
  | 'done' // password changed + confirmed
  | 'wrong_password' // Google rejected the old/current password
  | 'weak_password' // Google rejected the NEW password (too weak / reused)
  | 'captcha' // stuck on a captcha / reCAPTCHA (no solver configured)
  | 'needs_manual' // a 2FA / identity challenge we can't clear automatically
  | 'not_found' // no profile matched this email
  | 'error' // launch / CDP / unexpected failure

export interface GmailChangeResult {
  email: string
  profileId?: string
  status: GmailChangeStatus
  message: string
}

/** Live progress pushed to the renderer while a single account is processed. */
export interface GmailProgress {
  profileId: string
  email: string
  phase: string // machine state: 'launch' | 'signin' | 'reauth' | 'newpass' | 'challenge' | 'done' | ...
  message: string // human-readable Vietnamese status
}

/** Result of an auto Gmail sign-in. live = logged in; die = wrong pass / no account;
 *  needs_manual = a challenge/captcha we couldn't clear. Maps to the profile's account.status. */
export type GmailLoginStatus = 'live' | 'die' | 'needs_manual' | 'error'
export interface GmailLoginResult {
  profileId: string
  email: string
  status: GmailLoginStatus
  message: string
}

/** Result of an RPA "warm-up" run (human-like Gmail activity to keep the account trusted). */
export type RpaStatus = 'done' | 'not_logged_in' | 'error'
export interface RpaResult {
  profileId: string
  name: string
  status: RpaStatus
  message: string
}

/** Per-account scheduled auto warm-up config. */
export interface WarmSchedule {
  enabled: boolean
  profileIds: string[]
  everyHours: number
  minutes: number
  lastRun?: string // ISO
}
