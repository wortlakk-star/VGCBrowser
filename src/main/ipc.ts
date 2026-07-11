// ── VGC Browser — IPC handlers ───────────────────────────────────────────────
// The single bridge between renderer (UI) and main (privileged). Every channel
// is invoke/handle (request/response); status changes are pushed separately via
// 'profile:status' from the profile manager.

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type {
  CloudSession,
  Cookie,
  CreateProfileInput,
  OsType,
  Profile,
  ProxyConfig,
  SavedProxy
} from '../shared/types'
import { generateFingerprint } from '../shared/fingerprint'
import { checkProxy } from './proxy-check'
import { createProfile, updateProfile } from './profiles-service'
import { getSettings, saveSettings, regenerateToken, type AppSettings } from './settings'
import { restartApiServer } from './api-manager'
import { ensureEngine, isEngineInstalled, type EngineProgress } from './engine-download'
import { checkForUpdates, getUpdateStatus, installUpdate, openDownloadPage } from './updater'
import {
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  removeMany,
  saveMany
} from './store'
import {
  launchProfile,
  stopProfile,
  allRuntimeStates,
  checkFingerprint,
  getProfileCookies,
  cookieRobot
} from './profile-manager'
import {
  listProxies,
  saveProxy,
  saveManyProxies,
  deleteProxy,
  removeManyProxies
} from './proxy-store'
import { uploadProfileData, downloadProfileData } from './cloud-data'
import { setCloudSession } from './session'
import {
  getAccountSecret,
  encryptWithSecret,
  decryptWithSecret,
  isEncryptionActive
} from './account-secret'
import {
  getProfileKey,
  shareProfile,
  listShares,
  unshareProfile,
  getSharedWithMe
} from './profile-share'
import { listGroups, createGroup, deleteGroup } from './group-store'
import { getProviderCreds, saveProviderCreds, buildProviderProxy } from './proxy-providers'
import type { ProviderCreds, ProxyBuildOpts, ProxyProviderId } from '../shared/types'

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

/** Normalize various cookie-export sameSite spellings to CDP's enum. */
function normalizeSameSite(v: unknown): Cookie['sameSite'] {
  const s = String(v ?? '').toLowerCase()
  if (s === 'strict') return 'Strict'
  if (s === 'lax') return 'Lax'
  if (s === 'none' || s === 'no_restriction') return 'None'
  return undefined
}

export function registerIpc(): void {
  ipcMain.handle('profiles:list', () => listProfiles())

  ipcMain.handle('profiles:runtimeStates', () => allRuntimeStates())

  ipcMain.handle('profiles:create', (_e, input: CreateProfileInput) => createProfile(input))

  ipcMain.handle('profiles:update', (_e, id: string, patch: Partial<Profile>) =>
    updateProfile(id, patch)
  )

  ipcMain.handle('profiles:delete', (_e, id: string) => deleteProfile(id))

  ipcMain.handle('profiles:duplicate', async (_e, id: string) => {
    const src = await getProfile(id)
    if (!src) throw new Error(`Không tìm thấy profile: ${id}`)
    const now = new Date().toISOString()
    const copy: Profile = {
      ...src,
      id: randomUUID(),
      name: `${src.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: undefined
    }
    return saveProfile(copy)
  })

  ipcMain.handle('profiles:launchMany', async (_e, ids: string[]) => {
    for (const id of ids) {
      try {
        await launchProfile(id)
      } catch {
        // keep launching the rest
      }
    }
  })

  ipcMain.handle('profiles:stopMany', (_e, ids: string[]) => {
    for (const id of ids) stopProfile(id)
  })

  ipcMain.handle('profiles:export', async (_e, ids?: string[]) => {
    const all = await listProfiles()
    const subset = ids && ids.length ? all.filter((p) => ids.includes(p.id)) : all
    const win = focusedWindow()
    const opts = {
      title: 'Xuất profiles',
      defaultPath: 'vgc-profiles.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const res = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { count: 0 }
    await fs.writeFile(res.filePath, JSON.stringify(subset, null, 2), 'utf-8')
    return { count: subset.length, filePath: res.filePath }
  })

  ipcMain.handle('profiles:import', async () => {
    const win = focusedWindow()
    const opts = {
      title: 'Nhập profiles',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile' as const]
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { count: 0 }
    const raw = await fs.readFile(res.filePaths[0], 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { count: 0, error: 'File không phải JSON hợp lệ.' }
    }
    if (!Array.isArray(parsed)) return { count: 0, error: 'File không hợp lệ (cần một mảng profile).' }
    const now = new Date().toISOString()
    // Defensive defaults: a hand-edited / foreign export may miss proxy/fingerprint/
    // startUrls, which would otherwise crash launchProfile later. Fill them in.
    const incoming: Profile[] = parsed.map((p: Partial<Profile>) => {
      const os: OsType = p.os ?? 'windows'
      return {
        ...p,
        id: randomUUID(),
        name: p.name || 'Imported profile',
        notes: p.notes ?? '',
        tags: Array.isArray(p.tags) ? p.tags : [],
        os,
        fingerprint: p.fingerprint ?? generateFingerprint(os),
        proxy: p.proxy ?? { type: 'none' },
        startUrls: Array.isArray(p.startUrls) ? p.startUrls : [],
        createdAt: now,
        updatedAt: now,
        lastUsedAt: undefined
      } as Profile
    })
    await saveMany(incoming)
    return { count: incoming.length }
  })

  ipcMain.handle('profiles:bulkUpsert', (_e, profiles: Profile[]) => saveMany(profiles))

  ipcMain.handle('profiles:removeMany', (_e, ids: string[]) => removeMany(ids))

  ipcMain.handle('profiles:launch', (_e, id: string) => launchProfile(id))

  // Clean-login mode: open with NO CDP/automation so Google sign-in works. Log in
  // once here; later normal opens reuse the saved session (already logged in).
  ipcMain.handle('profiles:loginClean', (_e, id: string) =>
    launchProfile(id, { cleanLogin: true })
  )

  ipcMain.handle('profiles:stop', (_e, id: string) => {
    stopProfile(id)
  })

  ipcMain.handle('profiles:checkFingerprint', (_e, id: string, url?: string) =>
    checkFingerprint(id, url)
  )

  ipcMain.handle('fingerprint:generate', (_e, os: OsType = 'windows') =>
    generateFingerprint(os)
  )

  ipcMain.handle('proxy:check', (_e, proxy: ProxyConfig) => checkProxy(proxy))

  ipcMain.handle('proxies:list', () => listProxies())
  ipcMain.handle('proxies:save', (_e, p: SavedProxy) => saveProxy(p))
  ipcMain.handle('proxies:saveMany', (_e, items: SavedProxy[]) => saveManyProxies(items))
  ipcMain.handle('proxies:delete', (_e, id: string) => deleteProxy(id))
  ipcMain.handle('proxies:removeMany', (_e, ids: string[]) => removeManyProxies(ids))

  ipcMain.handle('profiles:cookieRobot', (_e, id: string, urls?: string[]) =>
    cookieRobot(id, urls)
  )

  // ── Cloud profile DATA sync (GoLogin-style session sync) ──
  ipcMain.handle('cloud:setSession', (_e, sess: CloudSession | null) => {
    setCloudSession(sess)
  })
  ipcMain.handle('cloud:uploadData', (_e, id: string) => uploadProfileData(id))
  ipcMain.handle('cloud:downloadData', (_e, id: string) => downloadProfileData(id))
  // App-side encryption of the profile/proxy metadata BEFORE it's pushed to the
  // cloud DB (so cookies/proxy passwords in the jsonb are ciphertext, not plaintext).
  // Returns null when no account secret yet (pre-migration) → renderer falls back to
  // pushing plaintext so nothing breaks during rollout.
  // profileId given → use that profile's key (the SHARED key when it's shared, so
  // members decrypt it); otherwise the account secret (e.g. proxies).
  ipcMain.handle(
    'cloud:protect',
    async (_e, context: string, plaintext: string, profileId?: string) => {
      const secret = (profileId && (await getProfileKey(profileId))) || (await getAccountSecret())
      if (secret) return encryptWithSecret(secret, context, plaintext)
      // No key right now. If this account is known-encrypted, REFUSE (throwing aborts
      // the jsonb push) rather than returning null → the caller would upload plaintext
      // metadata over the encrypted cloud row. Only pre-migration accounts fall through.
      if (isEncryptionActive()) {
        throw new Error('VGC_ENC_ACTIVE_NO_KEY')
      }
      return null
    }
  )
  ipcMain.handle(
    'cloud:unprotect',
    async (_e, context: string, blob: string, profileId?: string) => {
      const secret = (profileId && (await getProfileKey(profileId))) || (await getAccountSecret())
      return secret ? decryptWithSecret(secret, context, blob) : null
    }
  )

  // ── Profile sharing ──
  ipcMain.handle('share:create', (_e, profileId: string, email: string, proxy: ProxyConfig | null) =>
    shareProfile(profileId, email, proxy)
  )
  ipcMain.handle('share:list', (_e, profileId: string) => listShares(profileId))
  ipcMain.handle('share:remove', (_e, profileId: string, email: string) =>
    unshareProfile(profileId, email)
  )
  ipcMain.handle('share:sharedWithMe', () => getSharedWithMe())

  // ── Profile groups (folders) ──
  ipcMain.handle('groups:list', () => listGroups())
  ipcMain.handle('groups:create', (_e, name: string) => createGroup(name))
  ipcMain.handle('groups:delete', (_e, name: string) => deleteGroup(name))

  // ── Proxy provider connectors (IPRoyal / Oxylabs / Bright Data) ──
  ipcMain.handle('providers:get', () => getProviderCreds())
  ipcMain.handle('providers:save', (_e, patch: ProviderCreds) => saveProviderCreds(patch))
  ipcMain.handle('providers:build', (_e, provider: ProxyProviderId, opts: ProxyBuildOpts) =>
    buildProviderProxy(provider, opts)
  )

  ipcMain.handle('dialog:pickFolder', async (): Promise<string | null> => {
    const win = focusedWindow()
    const opts = { title: 'Chọn thư mục extension', properties: ['openDirectory' as const] }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle('cookies:export', async (_e, id: string) => {
    const cookies = await getProfileCookies(id)
    if (!cookies) return { count: 0, error: 'Profile chưa chạy — mở profile rồi thử lại.' }
    const win = focusedWindow()
    const opts = {
      title: 'Xuất cookie',
      defaultPath: 'cookies.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const res = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { count: 0 }
    await fs.writeFile(res.filePath, JSON.stringify(cookies, null, 2), 'utf-8')
    return { count: cookies.length }
  })

  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:save', async (_e, patch: Partial<AppSettings>) => {
    const s = await saveSettings(patch)
    await restartApiServer()
    return s
  })

  ipcMain.handle('settings:regenerateToken', async () => {
    const s = await regenerateToken()
    await restartApiServer()
    return s
  })

  // ── App version + auto-update ──
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('update:statusGet', () => getUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('update:openDownload', () => openDownloadPage())

  ipcMain.handle('engine:installed', () => isEngineInstalled())

  ipcMain.handle('engine:ensure', async () => {
    const send = (p: EngineProgress): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('engine:progress', { id: '', ...p })
      }
    }
    try {
      await ensureEngine(send)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      send({ phase: 'error', message: msg })
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('cookies:import', async (): Promise<Cookie[]> => {
    const win = focusedWindow()
    const opts = {
      title: 'Nhập cookie (JSON)',
      filters: [{ name: 'JSON', extensions: ['json', 'txt'] }],
      properties: ['openFile' as const]
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return []
    const raw = await fs.readFile(res.filePaths[0], 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    const arr: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? ((parsed as { cookies: Array<Record<string, unknown>> }).cookies)
        : []
    return arr
      .map((c) => ({
        name: String(c.name ?? ''),
        value: String(c.value ?? ''),
        domain: String(c.domain ?? ''),
        path: typeof c.path === 'string' ? c.path : '/',
        expires:
          typeof c.expires === 'number'
            ? c.expires
            : typeof c.expirationDate === 'number'
              ? Math.floor(c.expirationDate as number)
              : undefined,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: normalizeSameSite(c.sameSite)
      }))
      .filter((c) => c.name && c.domain)
  })
}
