// ── VGC Browser — preload bridge ─────────────────────────────────────────────
// Exposes a minimal, typed `window.vgc` API to the renderer. The renderer never
// touches Node or ipcRenderer directly (contextIsolation = true).

import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  CloudSession,
  Cookie,
  CreateProfileInput,
  DataSyncState,
  EngineProgress,
  Fingerprint,
  GenerateProxiesOpts,
  GmailChangeResult,
  GmailLoginResult,
  GmailPasswordTask,
  RpaResult,
  WarmSchedule,
  GmailProgress,
  OsType,
  Profile,
  ProfileRuntimeState,
  ProviderCreds,
  ProxyBuildOpts,
  ProxyCheckResult,
  ProxyConfig,
  ProxyProviderId,
  SavedProxy,
  UpdateStatus
} from '../shared/types'

const api = {
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),

  runtimeStates: (): Promise<ProfileRuntimeState[]> =>
    ipcRenderer.invoke('profiles:runtimeStates'),

  createProfile: (input: CreateProfileInput): Promise<Profile> =>
    ipcRenderer.invoke('profiles:create', input),

  updateProfile: (id: string, patch: Partial<Profile>): Promise<Profile> =>
    ipcRenderer.invoke('profiles:update', id, patch),

  deleteProfile: (id: string): Promise<void> =>
    ipcRenderer.invoke('profiles:delete', id),

  duplicateProfile: (id: string): Promise<Profile> =>
    ipcRenderer.invoke('profiles:duplicate', id),

  exportProfiles: (ids?: string[]): Promise<{ count: number; filePath?: string }> =>
    ipcRenderer.invoke('profiles:export', ids),

  importProfiles: (): Promise<{ count: number; error?: string }> =>
    ipcRenderer.invoke('profiles:import'),

  bulkUpsertProfiles: (profiles: Profile[], expectedUid?: string): Promise<void> =>
    ipcRenderer.invoke('profiles:bulkUpsert', profiles, expectedUid),

  removeProfiles: (ids: string[], expectedUid?: string): Promise<void> =>
    ipcRenderer.invoke('profiles:removeMany', ids, expectedUid),

  syncTimezones: (): Promise<{ synced: number; total: number; failed: number }> =>
    ipcRenderer.invoke('profiles:syncTimezones'),

  launchProfile: (id: string): Promise<ProfileRuntimeState> =>
    ipcRenderer.invoke('profiles:launch', id),

  loginClean: (id: string): Promise<ProfileRuntimeState> =>
    ipcRenderer.invoke('profiles:loginClean', id),

  launchMany: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('profiles:launchMany', ids),

  /** Open profiles tiled into a grid — each item has its window position/size. */
  launchGrid: (
    items: Array<{ id: string; x: number; y: number; w: number; h: number }>
  ): Promise<void> => ipcRenderer.invoke('profiles:launchGrid', items),

  stopProfile: (id: string): Promise<void> =>
    ipcRenderer.invoke('profiles:stop', id),

  stopMany: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('profiles:stopMany', ids),

  checkFingerprint: (id: string, url?: string): Promise<void> =>
    ipcRenderer.invoke('profiles:checkFingerprint', id, url),

  generateFingerprint: (os?: OsType): Promise<Fingerprint> =>
    ipcRenderer.invoke('fingerprint:generate', os),

  checkProxy: (proxy: ProxyConfig): Promise<ProxyCheckResult> =>
    ipcRenderer.invoke('proxy:check', proxy),

  /** Current 6-digit 2FA code for a base32 secret ('' if invalid). */
  totpNow: (secret: string): Promise<string> => ipcRenderer.invoke('totp:now', secret),

  listProxies: (): Promise<SavedProxy[]> => ipcRenderer.invoke('proxies:list'),
  saveProxy: (p: SavedProxy): Promise<SavedProxy> => ipcRenderer.invoke('proxies:save', p),
  saveManyProxies: (items: SavedProxy[], expectedUid?: string): Promise<number> =>
    ipcRenderer.invoke('proxies:saveMany', items, expectedUid),
  deleteProxy: (id: string): Promise<void> => ipcRenderer.invoke('proxies:delete', id),
  removeProxies: (ids: string[], expectedUid?: string): Promise<void> =>
    ipcRenderer.invoke('proxies:removeMany', ids, expectedUid),

  cookieRobot: (id: string, urls?: string[]): Promise<void> =>
    ipcRenderer.invoke('profiles:cookieRobot', id, urls),

  importCookies: (): Promise<Cookie[]> => ipcRenderer.invoke('cookies:import'),

  exportCookies: (id: string): Promise<{ count: number; error?: string }> =>
    ipcRenderer.invoke('cookies:export', id),

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),

  saveSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', patch),

  regenerateApiToken: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:regenerateToken'),

  /** Subscribe to runtime status changes. Returns an unsubscribe fn. */
  onStatus: (cb: (state: ProfileRuntimeState) => void): (() => void) => {
    const listener = (_e: unknown, state: ProfileRuntimeState): void => cb(state)
    ipcRenderer.on('profile:status', listener)
    return () => ipcRenderer.removeListener('profile:status', listener)
  },

  // ── Bulk Gmail password change ──
  changeGmailPassword: (profileId: string, task: GmailPasswordTask): Promise<GmailChangeResult> =>
    ipcRenderer.invoke('gmail:changePassword', profileId, task),

  /** Auto sign-in these profiles into Gmail using their stored creds; sets live/die. */
  gmailLogin: (profileIds: string[]): Promise<GmailLoginResult[]> =>
    ipcRenderer.invoke('gmail:login', profileIds),

  /** RPA warm-up: human-like Gmail activity on each profile for `minutes` to keep it trusted. */
  warmupProfiles: (profileIds: string[], minutes?: number): Promise<RpaResult[]> =>
    ipcRenderer.invoke('rpa:warmup', profileIds, minutes),

  /** Scheduled auto warm-up config (per account). */
  getWarmSchedule: (): Promise<WarmSchedule> => ipcRenderer.invoke('warm:getSchedule'),
  setWarmSchedule: (patch: Partial<WarmSchedule>): Promise<WarmSchedule> =>
    ipcRenderer.invoke('warm:setSchedule', patch),

  /** Append a redacted email/status audit record; the password is never written to disk. */
  logGmailResult: (line: string): Promise<string> => ipcRenderer.invoke('gmail:logResult', line),

  /** Live per-account progress while a batch runs. Returns an unsubscribe fn. */
  onGmailProgress: (cb: (p: GmailProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: GmailProgress): void => cb(p)
    ipcRenderer.on('gmail:progress', listener)
    return () => ipcRenderer.removeListener('gmail:progress', listener)
  },

  // ── App version + auto-update (check → download → install) ──
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  // Forced-update gate: is this build still allowed to run?
  versionGate: (): Promise<{
    blocked: boolean
    current: string
    min: string
    downloadUrl: string
  }> => ipcRenderer.invoke('app:versionGate'),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),

  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:statusGet'),

  checkForUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),

  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),

  openUpdateDownload: (): Promise<void> => ipcRenderer.invoke('update:openDownload'),

  onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: UpdateStatus): void => cb(s)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },

  // ── On-demand engine (download VGC Core from server, GoLogin-style) ──
  engineInstalled: (): Promise<boolean> => ipcRenderer.invoke('engine:installed'),

  ensureEngine: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('engine:ensure'),

  onEngineProgress: (cb: (p: EngineProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: EngineProgress): void => cb(p)
    ipcRenderer.on('engine:progress', listener)
    return () => ipcRenderer.removeListener('engine:progress', listener)
  },

  // ── Cloud profile DATA sync (GoLogin-style: session follows the account) ──
  cloudSetSession: (sess: CloudSession | null): Promise<boolean> =>
    ipcRenderer.invoke('cloud:setSession', sess),

  cloudAuthGet: (key: string): Promise<string | null> => ipcRenderer.invoke('cloud:authGet', key),
  cloudAuthSet: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('cloud:authSet', key, value),
  cloudAuthRemove: (key: string): Promise<void> => ipcRenderer.invoke('cloud:authRemove', key),

  cloudEncryptionStatus: (): Promise<{ configured: boolean; unlocked: boolean }> =>
    ipcRenderer.invoke('cloud:encryptionStatus'),

  cloudSetPassphrase: (passphrase: string): Promise<void> =>
    ipcRenderer.invoke('cloud:setPassphrase', passphrase),

  cloudUploadData: (id: string): Promise<void> =>
    ipcRenderer.invoke('cloud:uploadData', id),

  cloudDownloadData: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('cloud:downloadData', id),

  // Encrypt/decrypt metadata with the per-account secret before/after it touches the
  // cloud DB. Encryption failure rejects; callers must never downgrade to plaintext.
  cloudProtect: (
    context: string,
    plaintext: string,
    expectedUid: string,
    profileId?: string
  ): Promise<string> => ipcRenderer.invoke('cloud:protect', context, plaintext, expectedUid, profileId),
  cloudUnprotect: (
    context: string,
    blob: string,
    expectedUid: string,
    profileId?: string
  ): Promise<{ plaintext: string; legacy: boolean } | null> =>
    ipcRenderer.invoke('cloud:unprotect', context, blob, expectedUid, profileId),

  // ── Profile sharing ──
  shareCreate: (
    profileId: string,
    email: string,
    proxy: ProxyConfig | null
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('share:create', profileId, email, proxy),
  shareList: (profileId: string): Promise<Array<{ email: string }>> =>
    ipcRenderer.invoke('share:list', profileId),
  shareRemove: (profileId: string, email: string): Promise<void> =>
    ipcRenderer.invoke('share:remove', profileId, email),
  shareSharedWithMe: (): Promise<
    Array<{ profileId: string; owner: string; proxy: ProxyConfig | null }>
  > => ipcRenderer.invoke('share:sharedWithMe'),

  // ── Profile groups ──
  listGroups: (): Promise<string[]> => ipcRenderer.invoke('groups:list'),
  createGroup: (name: string): Promise<string[]> => ipcRenderer.invoke('groups:create', name),
  deleteGroup: (name: string): Promise<string[]> => ipcRenderer.invoke('groups:delete', name),

  // ── Proxy provider connectors ──
  getProviderCreds: (): Promise<ProviderCreds> => ipcRenderer.invoke('providers:get'),
  saveProviderCreds: (patch: ProviderCreds): Promise<ProviderCreds> =>
    ipcRenderer.invoke('providers:save', patch),
  buildProviderProxy: (provider: ProxyProviderId, opts: ProxyBuildOpts): Promise<ProxyConfig> =>
    ipcRenderer.invoke('providers:build', provider, opts),
  generateProviderProxies: (opts: GenerateProxiesOpts): Promise<SavedProxy[]> =>
    ipcRenderer.invoke('providers:generate', opts),
  getProviderBalance: (
    provider?: ProxyProviderId,
    product?: string
  ): Promise<{ availableGb: number; subusers: number }> =>
    ipcRenderer.invoke('providers:balance', provider, product),

  onDataSync: (cb: (state: DataSyncState) => void): (() => void) => {
    const listener = (_e: unknown, state: DataSyncState): void => cb(state)
    ipcRenderer.on('profile:dataSync', listener)
    return () => ipcRenderer.removeListener('profile:dataSync', listener)
  }
}

contextBridge.exposeInMainWorld('vgc', api)

export type VgcApi = typeof api
