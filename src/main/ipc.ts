// ── VGC Browser — IPC handlers ───────────────────────────────────────────────
// The single bridge between renderer (UI) and main (privileged). Every channel
// is invoke/handle (request/response); status changes are pushed separately via
// 'profile:status' from the profile manager.

import { ipcMain, dialog, BrowserWindow, app, shell, type IpcMainInvokeEvent } from 'electron'
import { checkVersionGate } from './version-gate'
import { randomUUID } from 'crypto'
import { constants as fsConstants, promises as fs } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
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
import { generateTotp, looksLikeTotpSecret } from './totp'

const ACCOUNT_STATUSES = new Set(['live', 'die', 'banned', 'ready'])
const CLOUD_ENVELOPE_PREFIX = 'VGC2:'
import { checkProxy } from './proxy-check'
import {
  createProfile,
  updateProfile,
  cohereFingerprint,
  hostOs,
  hostFingerprintEnvironment
} from './profiles-service'
import {
  requireProfileId,
  requireProfileIds,
  requireUuid,
  requireTokenId,
  requireTokenIds,
  sanitizeCookies,
  sanitizeProxyConfig,
  trustedExternalUrl
} from './validation'
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
  cookieRobot,
  syncTimezonesToProxies,
  stopAllForAccountSwitch
} from './profile-manager'
import {
  listProxies,
  saveProxy,
  saveManyProxies,
  deleteProxy,
  removeManyProxies
} from './proxy-store'
import { uploadProfileData, downloadProfileData } from './cloud-data'
import { changeGmailPassword } from './gmail-password'
import { gmailLogin } from './gmail-login'
import { runWarmup } from './rpa'
import { getSchedule, setSchedule } from './warmup-scheduler'
import {
  commitValidatedCloudSession,
  getCloudSession,
  validateCloudSession
} from './session'
import {
  accountTransitionInProgress,
  runAccountOperation,
  runAccountTransition
} from './account-operations'
import {
  getAccountSecret,
  encryptWithSecret,
  decryptWithSecret,
  cloudEncryptionStatus,
  setCloudEncryptionPassphrase,
  clearAccountSecretCache
} from './account-secret'
import {
  getProfileKey,
  shareProfile,
  listShares,
  unshareProfile,
  getSharedWithMe
} from './profile-share'
import { listGroups, createGroup, deleteGroup } from './group-store'
import { getCloudAuth, setCloudAuth, removeCloudAuth } from './cloud-auth-store'
import {
  getProviderCreds,
  saveProviderCreds,
  buildProviderProxy,
  generateIproyalProxies,
  iproyalBalance,
  generateEvomiProxies,
  evomiBalance,
  generateCliproxyProxies
} from './proxy-providers'
import type {
  ProviderCreds,
  ProxyBuildOpts,
  ProxyProviderId,
  GenerateProxiesOpts,
  GmailPasswordTask,
  GmailProgress,
  GmailLoginResult,
  RpaResult,
  WarmSchedule
} from '../shared/types'

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

const rawHandle = ipcMain.handle.bind(ipcMain)

function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  if (!BrowserWindow.fromWebContents(event.sender)) return false
  const raw = event.senderFrame?.url || event.sender.getURL()
  try {
    const url = new URL(raw)
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      return url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    }
    return (
      url.protocol === 'file:' &&
      fileURLToPath(url) === join(__dirname, '../renderer/index.html')
    )
  } catch {
    return false
  }
}

function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => any
): void {
  rawHandle(channel, (event, ...args) => {
    if (!isTrustedRenderer(event)) throw new Error('IPC sender không được phép')
    return listener(event, ...args)
  })
}

function requireCurrentAccount(expectedUid: unknown, required = false): void {
  if (expectedUid === undefined) {
    if (required) throw new Error('Thiếu tài khoản cho thao tác cloud.')
    return
  }
  const uid = requireUuid(expectedUid, 'Account ID')
  if (getCloudSession()?.uid !== uid) throw new Error('Tài khoản đã thay đổi; thao tác cloud bị huỷ.')
}

let cloudSessionRevision = 0

/** Normalize various cookie-export sameSite spellings to CDP's enum. */
function normalizeSameSite(v: unknown): Cookie['sameSite'] {
  const s = String(v ?? '').toLowerCase()
  if (s === 'strict') return 'Strict'
  if (s === 'lax') return 'Lax'
  if (s === 'none' || s === 'no_restriction') return 'None'
  return undefined
}

function redactProfileForExport(profile: Profile): Record<string, unknown> {
  const {
    cookies: _cookies,
    extensions: _extensions,
    proxyCheck: _proxyCheck,
    cloudTeamId: _cloudTeamId,
    ...base
  } = profile
  const { username: _proxyUser, password: _proxyPassword, ...safeProxy } = profile.proxy
  const safeAccount = profile.account
    ? { user: profile.account.user, status: profile.account.status }
    : undefined
  return { ...base, proxy: safeProxy, account: safeAccount }
}

async function writePrivateText(file: string, text: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Dữ liệu xuất vượt giới hạn.')
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temp, file)
    await fs.chmod(file, 0o600).catch(() => {})
  } finally {
    await fs.unlink(temp).catch(() => {})
  }
}

async function readBoundedRegularText(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > maxBytes) {
      throw new Error('File không phải file thường hoặc vượt giới hạn.')
    }
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes) throw new Error('File vượt giới hạn an toàn.')
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function appendPrivateLog(file: string, line: string): Promise<void> {
  const handle = await fs.open(
    file,
    fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('File log không an toàn.')
    await handle.writeFile(line, 'utf8')
    await handle.chmod(0o600).catch(() => {})
  } finally {
    await handle.close()
  }
}

export function registerIpc(): void {
  handle('profiles:list', () => listProfiles())

  handle('profiles:runtimeStates', () => allRuntimeStates())

  handle('profiles:create', (_e, input: CreateProfileInput) => createProfile(input))

  handle('profiles:update', (_e, id: string, patch: Partial<Profile>) =>
    updateProfile(requireProfileId(id), patch)
  )

  handle('profiles:delete', (_e, id: string) => deleteProfile(requireProfileId(id)))

  handle('profiles:duplicate', async (_e, id: string) => {
    requireProfileId(id)
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

  handle('profiles:launchMany', async (_e, ids: string[]) => {
    for (const id of requireProfileIds(ids, 100)) {
      try {
        await launchProfile(id)
      } catch {
        // keep launching the rest
      }
    }
  })

  // Open profiles tiled into a grid: each item carries its computed window position/size.
  handle(
    'profiles:launchGrid',
    async (_e, items: Array<{ id: string; x: number; y: number; w: number; h: number }>) => {
      if (!Array.isArray(items) || items.length > 100) throw new Error('Danh sách cửa sổ không hợp lệ')
      for (const it of items) {
        const id = requireProfileId(it?.id)
        const x = Math.max(-20_000, Math.min(20_000, Math.trunc(Number(it?.x) || 0)))
        const y = Math.max(-20_000, Math.min(20_000, Math.trunc(Number(it?.y) || 0)))
        const w = Math.max(400, Math.min(7680, Math.trunc(Number(it?.w) || 1200)))
        const h = Math.max(300, Math.min(4320, Math.trunc(Number(it?.h) || 800)))
        try {
          await launchProfile(id, { window: { x, y, w, h } })
        } catch {
          // keep launching the rest
        }
      }
    }
  )

  handle('profiles:stopMany', (_e, ids: string[]) => {
    for (const id of requireProfileIds(ids, 500)) stopProfile(id)
  })

  handle('profiles:export', async (_e, ids?: string[]) => {
    const all = await listProfiles()
    const selected = ids && ids.length ? requireProfileIds(ids, 10_000) : null
    const subset = (selected ? all.filter((p) => selected.includes(p.id)) : all).map(
      redactProfileForExport
    )
    const win = focusedWindow()
    const opts = {
      title: 'Xuất profiles',
      defaultPath: 'vgc-profiles-redacted.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const res = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { count: 0 }
    await writePrivateText(res.filePath, JSON.stringify(subset, null, 2), 64 * 1024 * 1024)
    return { count: subset.length, filePath: res.filePath }
  })

  handle('profiles:import', async () => {
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
    let raw = ''
    try {
      raw = await readBoundedRegularText(res.filePaths[0], 16 * 1024 * 1024)
    } catch {
      return { count: 0, error: 'File profile không an toàn hoặc vượt giới hạn 16 MB.' }
    }
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
    const incoming: Profile[] = parsed
      .slice(0, 10_000)
      // Drop null/primitive/array entries first — a null element in a hand-edited/foreign export
      // would otherwise throw on `p.os` and reject the whole import (an unhandled rejection in the
      // renderer, which shows the user nothing).
      .filter((p): p is Partial<Profile> => !!p && typeof p === 'object' && !Array.isArray(p))
      .map((p: Partial<Profile>) => {
      const os: OsType = hostOs()
      return {
        ...p,
        id: randomUUID(),
        name: p.name || 'Imported profile',
        notes: p.notes ?? '',
        tags: Array.isArray(p.tags) ? p.tags : [],
        os,
        fingerprint: cohereFingerprint(p.fingerprint),
        proxy: p.proxy ?? { type: 'none' },
        startUrls: Array.isArray(p.startUrls) ? p.startUrls : [],
        // Normalize an out-of-vocabulary account.status (foreign export / other version) so a bad
        // value can't reach the store + crash the list's status-pill render.
        account: p.account
          ? {
              ...p.account,
              status: ACCOUNT_STATUSES.has(p.account.status as string) ? p.account.status : undefined
            }
          : undefined,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: undefined
      } as Profile
    })
    await saveMany(incoming)
    return { count: incoming.length }
  })

  handle('profiles:bulkUpsert', (_e, profiles: Profile[], expectedUid?: string) => {
    requireCurrentAccount(expectedUid)
    if (!Array.isArray(profiles) || profiles.length > 10_000) throw new Error('Danh sách profile không hợp lệ')
    const portable = expectedUid
      ? profiles.map(({ extensions: _extensions, ...profile }) => profile as Profile)
      : profiles
    return saveMany(portable)
  })

  handle('profiles:removeMany', (_e, ids: string[], expectedUid?: string) => {
    requireCurrentAccount(expectedUid)
    return removeMany(requireProfileIds(ids, 10_000))
  })

  // Align every profile's timezone/geolocation to its proxy's exit IP (persisted).
  handle('profiles:syncTimezones', () => runAccountOperation(() => syncTimezonesToProxies()))

  handle('profiles:launch', (_e, id: string) => launchProfile(requireProfileId(id)))

  // Clean-login mode: open with NO CDP/automation so Google sign-in works. Log in
  // once here; later normal opens reuse the saved session (already logged in).
  handle('profiles:loginClean', (_e, id: string) =>
    launchProfile(requireProfileId(id), { cleanLogin: true })
  )

  handle('profiles:stop', (_e, id: string) => {
    stopProfile(requireProfileId(id))
  })

  handle('profiles:checkFingerprint', (_e, id: string, url?: string) =>
    checkFingerprint(requireProfileId(id), url)
  )

  handle('fingerprint:generate', (_e, os?: OsType) => {
    if (os && os !== hostOs()) throw new Error('Chỉ tạo fingerprint cùng OS với máy đang chạy')
    return generateFingerprint(hostOs(), hostFingerprintEnvironment())
  })

  // Current 6-digit 2FA code for a stored base32 secret (empty if the secret is invalid).
  handle('totp:now', (_e, secret: string) =>
    typeof secret === 'string' && secret.length <= 256 && looksLikeTotpSecret(secret) ? generateTotp(secret) : ''
  )

  handle('proxy:check', (_e, proxy: ProxyConfig) => checkProxy(sanitizeProxyConfig(proxy)))

  handle('proxies:list', () => listProxies())
  handle('proxies:save', (_e, p: SavedProxy) => saveProxy(p))
  handle('proxies:saveMany', (_e, items: SavedProxy[], expectedUid?: string) => {
    requireCurrentAccount(expectedUid)
    return saveManyProxies(items)
  })
  handle('proxies:delete', (_e, id: string) => deleteProxy(requireTokenId(id, 'Proxy ID')))
  handle('proxies:removeMany', (_e, ids: string[], expectedUid?: string) => {
    requireCurrentAccount(expectedUid)
    return removeManyProxies(requireTokenIds(ids))
  })

  handle('profiles:cookieRobot', (_e, id: string, urls?: string[]) =>
    runAccountOperation(() => cookieRobot(requireProfileId(id), urls))
  )

  // ── Bulk Gmail password change (drives Google's flow inside the profile) ──
  handle(
    'gmail:changePassword',
    (_e, profileId: string, task: GmailPasswordTask) => {
      if (!task || typeof task !== 'object') throw new Error('Tác vụ Gmail không hợp lệ')
      const safeTask: GmailPasswordTask = {
        email: String(task.email ?? '').trim().slice(0, 320),
        oldPassword: String(task.oldPassword ?? '').slice(0, 2048),
        newPassword: String(task.newPassword ?? '').slice(0, 2048),
        totpSecret: String(task.totpSecret ?? '').replace(/\s+/g, '').slice(0, 256) || undefined
      }
      return runAccountOperation(() =>
        changeGmailPassword(requireProfileId(profileId), safeTask, (p: GmailProgress) => {
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send('gmail:progress', p)
        })
      )
    }
  )

  // Auto sign-in to Gmail for a batch of profiles (uses each profile's stored account creds).
  // Runs sequentially; broadcasts progress; sets account.status to live/die from the result.
  handle('gmail:login', (_e, profileIds: string[]): Promise<GmailLoginResult[]> => runAccountOperation(async () => {
    const emit = (p: GmailProgress): void => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('gmail:progress', p)
    }
    const results: GmailLoginResult[] = []
    for (const id of requireProfileIds(profileIds, 100)) {
      const prof = await getProfile(id)
      const acc = prof?.account
      if (!prof || !acc?.user || !acc?.pass) {
        const r: GmailLoginResult = {
          profileId: id,
          email: acc?.user ?? '',
          status: 'error',
          message: 'Thiếu email/mật khẩu (Sửa profile → 👤 Tài khoản)'
        }
        results.push(r)
        emit({ profileId: id, email: r.email, phase: 'error', message: r.message })
        continue
      }
      const r = await gmailLogin(id, { email: acc.user, password: acc.pass, totpSecret: acc.totp }, emit)
      results.push(r)
      // Reflect a definitive live/die on the profile (leave status alone for needs_manual/error).
      // Re-read the account right before writing so a concurrent edit made during the (up to
      // 120s) login isn't clobbered by the pre-run snapshot — only the status changes.
      if (r.status === 'live' || r.status === 'die') {
        const cur = await getProfile(id)
        await updateProfile(id, {
          account: { ...(cur?.account ?? acc), status: r.status }
        }).catch(() => {})
      }
    }
    return results
  }))

  // RPA warm-up: human-like Gmail activity on a batch of profiles to keep them trusted.
  handle(
    'rpa:warmup',
    (_e, profileIds: string[], minutes?: number): Promise<RpaResult[]> => runAccountOperation(async () => {
      const emit = (p: GmailProgress): void => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('gmail:progress', p)
      }
      const results: RpaResult[] = []
      for (const id of requireProfileIds(profileIds, 100)) {
        const prof = await getProfile(id)
        if (!prof) continue
        results.push(await runWarmup(id, prof.name, { minutes }, emit))
      }
      return results
    })
  )

  // Scheduled auto warm-up config (per account).
  handle('warm:getSchedule', () => getSchedule())
  handle('warm:setSchedule', (_e, patch: Partial<WarmSchedule>) => {
    // Only the scheduler tick may set lastRun — strip it from renderer patches so a stale
    // round-trip can't revert the tick's fresh stamp (which would re-run the batch early).
    const { lastRun: _drop, ...safe } = patch
    return setSchedule(safe)
  })

  // Keep an operational audit trail without persisting the new password. Passwords
  // remain only in the encrypted profile store.
  handle('gmail:logResult', async (_e, line: string): Promise<string> => {
    const file = join(app.getPath('userData'), 'gmail-password-log.txt')
    const stamp = new Date().toISOString()
    const [email = '', _password = '', status = ''] = String(line).slice(0, 4096).split('|')
    const safeEmail = email.replace(/[\r\n\t]/g, '').slice(0, 320)
    const safeStatus = status.replace(/[\r\n\t]/g, '').slice(0, 120)
    await appendPrivateLog(file, `${stamp}\t${safeEmail}|[redacted]|${safeStatus}\n`).catch(
      () => {}
    )
    return file
  })

  // ── Cloud profile DATA sync (GoLogin-style session sync) ──
  handle('cloud:setSession', async (_e, sess: CloudSession | null) => {
    const revision = ++cloudSessionRevision
    const nextUid = sess?.uid ?? null
    if (sess) await validateCloudSession(sess)
    if (revision !== cloudSessionRevision) return false
    const currentUid = getCloudSession()?.uid ?? null
    if (currentUid === nextUid && !accountTransitionInProgress()) {
      commitValidatedCloudSession(sess)
      clearAccountSecretCache()
      return true
    }
    return runAccountTransition(async () => {
      if (revision !== cloudSessionRevision) return false
      if ((getCloudSession()?.uid ?? null) !== nextUid) await stopAllForAccountSwitch()
      if (revision !== cloudSessionRevision) return false
      commitValidatedCloudSession(sess)
      clearAccountSecretCache()
      return true
    })
  })
  handle('cloud:authGet', (_e, key: string) => getCloudAuth(key))
  handle('cloud:authSet', (_e, key: string, value: string) => setCloudAuth(key, value))
  handle('cloud:authRemove', (_e, key: string) => removeCloudAuth(key))
  handle('cloud:encryptionStatus', () => cloudEncryptionStatus())
  handle('cloud:setPassphrase', (_e, passphrase: string) =>
    runAccountOperation(() =>
      setCloudEncryptionPassphrase(String(passphrase ?? '').slice(0, 1024))
    )
  )
  handle('cloud:uploadData', (_e, id: string) =>
    runAccountOperation(() => uploadProfileData(requireProfileId(id)))
  )
  handle('cloud:downloadData', (_e, id: string) =>
    runAccountOperation(() => downloadProfileData(requireProfileId(id)))
  )
  // App-side encryption of the profile/proxy metadata BEFORE it's pushed to the
  // cloud DB (so cookies/proxy passwords in the jsonb are ciphertext, not plaintext).
  // Missing key material is a hard error; cloud writes never downgrade to plaintext.
  handle(
    'cloud:protect',
    (_e, context: string, plaintext: string, expectedUid: string, objectId?: string) => runAccountOperation(async () => {
      requireCurrentAccount(expectedUid, true)
      if (
        !['profile', 'proxy'].includes(context) ||
        typeof plaintext !== 'string' ||
        Buffer.byteLength(plaintext, 'utf8') > 16 * 1024 * 1024
      ) {
        throw new Error('Dữ liệu mã hoá cloud không hợp lệ')
      }
      const safeObjectId =
        context === 'profile'
          ? requireProfileId(objectId)
          : requireTokenId(objectId, 'Proxy ID')
      const sharedSecret = context === 'profile' ? await getProfileKey(safeObjectId) : null
      const secret = sharedSecret || (await getAccountSecret())
      if (!secret) throw new Error('VGC_ENCRYPTION_KEY_REQUIRED')
      let safePlaintext = plaintext
      // A shared browser session does not require handing the recipient the owner's
      // Gmail password or TOTP seed. The separately selected share proxy is encrypted
      // in profile_shares, so credentials are removed from the profile payload too.
      if (context === 'profile') {
        try {
          const profile = JSON.parse(plaintext) as Profile
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
            throw new Error('invalid profile')
          }
          if (profile.id !== safeObjectId) throw new Error('profile id mismatch')
          const { extensions: _extensions, ...portable } = profile
          safePlaintext = JSON.stringify(
            sharedSecret
              ? {
                  ...portable,
                  account: profile.account
                    ? { user: profile.account.user, status: profile.account.status }
                    : undefined,
                  proxy: profile.proxy
                    ? {
                        type: profile.proxy.type,
                        host: profile.proxy.host,
                        port: profile.proxy.port,
                        provider: profile.proxy.provider
                      }
                    : { type: 'none' }
                }
              : portable
          )
        } catch {
          throw new Error('Dữ liệu profile không hợp lệ')
        }
      } else {
        try {
          const proxy = JSON.parse(plaintext) as SavedProxy
          if (!proxy || typeof proxy !== 'object' || proxy.id !== safeObjectId) {
            throw new Error('proxy id mismatch')
          }
        } catch {
          throw new Error('Dữ liệu proxy không hợp lệ')
        }
      }
      return (
        CLOUD_ENVELOPE_PREFIX +
        encryptWithSecret(secret, `${context}:${safeObjectId}`, safePlaintext)
      )
    })
  )
  handle(
    'cloud:unprotect',
    (_e, context: string, blob: string, expectedUid: string, objectId?: string) => runAccountOperation(async () => {
      requireCurrentAccount(expectedUid, true)
      if (!['profile', 'proxy'].includes(context) || typeof blob !== 'string' || blob.length > 24 * 1024 * 1024) {
        throw new Error('Dữ liệu giải mã cloud không hợp lệ')
      }
      const safeObjectId =
        context === 'profile'
          ? requireProfileId(objectId)
          : requireTokenId(objectId, 'Proxy ID')
      const secret =
        (context === 'profile' && (await getProfileKey(safeObjectId))) ||
        (await getAccountSecret())
      if (!secret) return null
      const legacy = !blob.startsWith(CLOUD_ENVELOPE_PREFIX)
      const ciphertext = legacy ? blob : blob.slice(CLOUD_ENVELOPE_PREFIX.length)
      const plaintext = decryptWithSecret(
        secret,
        legacy ? context : `${context}:${safeObjectId}`,
        ciphertext
      )
      if (!plaintext) return null
      try {
        const value = JSON.parse(plaintext) as { id?: unknown }
        if (!value || typeof value !== 'object' || value.id !== safeObjectId) return null
      } catch {
        return null
      }
      return { plaintext, legacy }
    })
  )

  // ── Profile sharing ──
  handle('share:create', (_e, profileId: string, email: string, proxy: ProxyConfig | null) =>
    runAccountOperation(() =>
      shareProfile(requireProfileId(profileId), email, proxy ? sanitizeProxyConfig(proxy) : null)
    )
  )
  handle('share:list', (_e, profileId: string) =>
    runAccountOperation(() => listShares(requireProfileId(profileId)))
  )
  handle('share:remove', (_e, profileId: string, email: string) =>
    runAccountOperation(() => unshareProfile(requireProfileId(profileId), email))
  )
  handle('share:sharedWithMe', () => runAccountOperation(() => getSharedWithMe()))

  // ── Profile groups (folders) ──
  handle('groups:list', () => listGroups())
  handle('groups:create', (_e, name: string) => createGroup(name))
  handle('groups:delete', (_e, name: string) => deleteGroup(name))

  // ── Proxy provider connectors (IPRoyal / Oxylabs / Bright Data) ──
  handle('providers:get', () => getProviderCreds())
  handle('providers:save', (_e, patch: ProviderCreds) => saveProviderCreds(patch))
  handle('providers:build', (_e, provider: ProxyProviderId, opts: ProxyBuildOpts) =>
    runAccountOperation(() => buildProviderProxy(provider, opts))
  )
  // Generate proxies on demand via the chosen provider's API (returns SavedProxy[] —
  // the renderer adds them to the pool with saveManyProxies). Defaults to iProyal.
  handle('providers:generate', (_e, opts: GenerateProxiesOpts) =>
    runAccountOperation(() => {
      const provider =
        opts && typeof opts === 'object' && !Array.isArray(opts) ? opts.provider : undefined
      return provider === 'cliproxy'
        ? generateCliproxyProxies(opts)
        : provider === 'evomi'
          ? generateEvomiProxies(opts)
          : generateIproyalProxies(opts)
    })
  )
  // Remaining balance (GB) on the provider account.
  handle('providers:balance', (_e, provider?: ProxyProviderId, product?: string) =>
    runAccountOperation(() =>
      provider === 'evomi' ? evomiBalance(product) : iproyalBalance()
    )
  )

  handle('dialog:pickFolder', async (): Promise<string | null> => {
    const win = focusedWindow()
    const opts = { title: 'Chọn thư mục extension', properties: ['openDirectory' as const] }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  handle('cookies:export', async (_e, id: string) => {
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
    await writePrivateText(res.filePath, JSON.stringify(cookies, null, 2), 64 * 1024 * 1024)
    return { count: cookies.length }
  })

  handle('settings:get', () => getSettings())

  handle('settings:save', async (_e, patch: Partial<AppSettings>) => {
    const s = await saveSettings(patch)
    await restartApiServer()
    return s
  })

  handle('settings:regenerateToken', async () => {
    const s = await regenerateToken()
    await restartApiServer()
    return s
  })

  // ── App version + auto-update ──
  handle('app:getVersion', () => app.getVersion())
  // Forced-update gate: renderer asks whether this build is still allowed.
  handle('app:versionGate', () => checkVersionGate())
  // Open an external https link (the "download the new version" button).
  handle('app:openExternal', (_e, url: string) => {
    const safe = trustedExternalUrl(url, new Set(['vgcbrowser.com', 'www.vgcbrowser.com']))
    if (safe) void shell.openExternal(safe)
  })
  handle('update:statusGet', () => getUpdateStatus())
  handle('update:check', () => checkForUpdates())
  handle('update:install', () => installUpdate())
  handle('update:openDownload', () => openDownloadPage())

  handle('engine:installed', () => isEngineInstalled())

  handle('engine:ensure', async () => {
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

  handle('cookies:import', async (): Promise<Cookie[]> => {
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
    let raw = ''
    try {
      raw = await readBoundedRegularText(res.filePaths[0], 16 * 1024 * 1024)
    } catch {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    // `parsed` may be null / a primitive (JSON.parse('null')) — guard before reading
    // `.cookies`, otherwise this throws OUTSIDE the try/catch above and rejects the IPC.
    const obj = parsed && typeof parsed === 'object' ? (parsed as { cookies?: unknown }) : null
    const arr: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? parsed
      : obj && Array.isArray(obj.cookies)
        ? (obj.cookies as Array<Record<string, unknown>>)
        : []
    return sanitizeCookies(arr
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
      .filter((c) => c.name && c.domain))
  })
}
