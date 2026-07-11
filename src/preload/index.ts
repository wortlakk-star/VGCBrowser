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

  importProfiles: (): Promise<{ count: number }> =>
    ipcRenderer.invoke('profiles:import'),

  bulkUpsertProfiles: (profiles: Profile[]): Promise<void> =>
    ipcRenderer.invoke('profiles:bulkUpsert', profiles),

  removeProfiles: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('profiles:removeMany', ids),

  launchProfile: (id: string): Promise<ProfileRuntimeState> =>
    ipcRenderer.invoke('profiles:launch', id),

  loginClean: (id: string): Promise<ProfileRuntimeState> =>
    ipcRenderer.invoke('profiles:loginClean', id),

  launchMany: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('profiles:launchMany', ids),

  stopProfile: (id: string): Promise<void> =>
    ipcRenderer.invoke('profiles:stop', id),

  stopMany: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('profiles:stopMany', ids),

  checkFingerprint: (id: string, url?: string): Promise<void> =>
    ipcRenderer.invoke('profiles:checkFingerprint', id, url),

  generateFingerprint: (os: OsType = 'windows'): Promise<Fingerprint> =>
    ipcRenderer.invoke('fingerprint:generate', os),

  checkProxy: (proxy: ProxyConfig): Promise<ProxyCheckResult> =>
    ipcRenderer.invoke('proxy:check', proxy),

  listProxies: (): Promise<SavedProxy[]> => ipcRenderer.invoke('proxies:list'),
  saveProxy: (p: SavedProxy): Promise<SavedProxy> => ipcRenderer.invoke('proxies:save', p),
  saveManyProxies: (items: SavedProxy[]): Promise<number> =>
    ipcRenderer.invoke('proxies:saveMany', items),
  deleteProxy: (id: string): Promise<void> => ipcRenderer.invoke('proxies:delete', id),
  removeProxies: (ids: string[]): Promise<void> => ipcRenderer.invoke('proxies:removeMany', ids),

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

  // ── App version + auto-update (check → download → install) ──
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

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
  cloudSetSession: (sess: CloudSession | null): Promise<void> =>
    ipcRenderer.invoke('cloud:setSession', sess),

  cloudUploadData: (id: string): Promise<void> =>
    ipcRenderer.invoke('cloud:uploadData', id),

  cloudDownloadData: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('cloud:downloadData', id),

  // Encrypt/decrypt metadata with the per-account secret before/after it touches the
  // cloud DB. Return null when no secret yet (pre-migration) → caller pushes plaintext.
  cloudProtect: (context: string, plaintext: string, profileId?: string): Promise<string | null> =>
    ipcRenderer.invoke('cloud:protect', context, plaintext, profileId),
  cloudUnprotect: (context: string, blob: string, profileId?: string): Promise<string | null> =>
    ipcRenderer.invoke('cloud:unprotect', context, blob, profileId),

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

  onDataSync: (cb: (state: DataSyncState) => void): (() => void) => {
    const listener = (_e: unknown, state: DataSyncState): void => cb(state)
    ipcRenderer.on('profile:dataSync', listener)
    return () => ipcRenderer.removeListener('profile:dataSync', listener)
  }
}

contextBridge.exposeInMainWorld('vgc', api)

export type VgcApi = typeof api
