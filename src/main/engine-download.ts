// ── VGC Browser — on-demand engine downloader ───────────────────────────────
// Like GoLogin fetching Orbita: the installer is light and does NOT bundle the
// ~hundreds-of-MB engine. On first launch we download the VGC Core engine .zip
// from the server (settings.engineUrl) into userData/engine/chromium and extract
// it. Subsequent launches use the local copy.

import { app } from 'electron'
import {
  constants as fsConstants,
  promises as fs,
  existsSync,
  createWriteStream,
  createReadStream,
  closeSync,
  fstatSync,
  openSync,
  readSync
} from 'fs'
import { join, resolve, sep } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import AdmZip from 'adm-zip'
import { getSettings } from './settings'
import {
  resolveEnginePath,
  isDedicatedEngine,
  macVgcCoreEngine
} from './engine'
import type { EngineProgress } from '../shared/types'
import { CHROME_BUILD } from '../shared/fingerprint'
import engineRelease from '../shared/engine-release.json'

export type { EngineProgress }

const MAX_ENGINE_DOWNLOAD = 1_500 * 1024 * 1024
const MAX_ENGINE_UNPACKED = 4 * 1024 * 1024 * 1024
const MAX_ENGINE_ENTRY = 1_500 * 1024 * 1024
const MAX_ENGINE_ENTRIES = 30_000
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function assertTrustedEngineUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('URL engine không hợp lệ.')
  const url = new URL(raw)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'vgcbrowser.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/dl\/[a-z0-9._-]+\.zip$/i.test(url.pathname)
  ) {
    throw new Error('URL engine không thuộc máy chủ phát hành tin cậy.')
  }
  return url
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function downloadFile(
  rawUrl: string,
  destination: string,
  onProgress?: (p: EngineProgress) => void
): Promise<void> {
  const url = assertTrustedEngineUrl(rawUrl)
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15 * 60_000) })
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Tải engine lỗi: HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length') || 0)
  if (total > MAX_ENGINE_DOWNLOAD) {
    await res.body.cancel().catch(() => {})
    throw new Error('Gói engine vượt giới hạn tải an toàn.')
  }
  let received = 0
  let lastPct = -1
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      if (received > MAX_ENGINE_DOWNLOAD) return cb(new Error('Gói engine vượt giới hạn tải an toàn.'))
      if (total) {
        const pct = Math.round((received / total) * 100)
        if (pct !== lastPct) {
          lastPct = pct
          onProgress?.({ phase: 'download', percent: pct, message: `Đang tải engine ${pct}%` })
        }
      }
      cb(null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(destination, { mode: 0o600, flags: 'wx' })
  )
}

function validateZip(zip: AdmZip, allowSafeSymlinks = false): void {
  const entries = zip.getEntries()
  if (!entries.length || entries.length > MAX_ENGINE_ENTRIES) {
    throw new Error('Gói engine có số lượng file không hợp lệ.')
  }
  const files = new Set<string>()
  const directories = new Set<string>()
  const symlinks = new Set<string>()
  const normalizedEntries: Array<{ name: string; symlink: boolean }> = []
  let unpacked = 0
  for (const entry of entries) {
    const rawName = entry.entryName
    const name = rawName.replace(/\\/g, '/').replace(entry.isDirectory ? /\/$/ : /$^/, '')
    const parts = name.split('/')
    const unixType = entry.header.fileAttr & 0o170000
    const size = Number(entry.header.size)
    if (
      !name ||
      name.startsWith('/') ||
      /^[a-z]:/i.test(name) ||
      parts.length > 64 ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          Buffer.byteLength(part, 'utf8') > 255 ||
          /[\0-\x1f<>:"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          WINDOWS_RESERVED_NAME.test(part)
      ) ||
      Buffer.byteLength(name, 'utf8') > 2048 ||
      name.includes('\0') ||
      entry.header.encrypted ||
      ![0, 8].includes(Number(entry.header.method)) ||
      !Number.isFinite(size) ||
      size < 0 ||
      size > MAX_ENGINE_ENTRY ||
      ![0, 0o040000, 0o100000, 0o120000].includes(unixType) ||
      (unixType === 0o120000 && !allowSafeSymlinks) ||
      (entry.isDirectory && unixType !== 0 && unixType !== 0o040000) ||
      (!entry.isDirectory && unixType === 0o040000)
    ) {
      throw new Error('Gói engine chứa đường dẫn không an toàn.')
    }
    const canonical = parts.map((part) => part.normalize('NFC').toLowerCase()).join('/')
    const isSymlink = unixType === 0o120000
    const canonicalParts = canonical.split('/')
    for (let i = 1; i < canonicalParts.length; i++) {
      const parent = canonicalParts.slice(0, i).join('/')
      if (files.has(parent)) throw new Error('Gói engine chứa xung đột file/thư mục.')
      directories.add(parent)
    }
    if (entry.isDirectory) {
      if (files.has(canonical)) throw new Error('Gói engine chứa xung đột file/thư mục.')
      directories.add(canonical)
    } else {
      if (files.has(canonical) || directories.has(canonical)) {
        throw new Error('Gói engine chứa đường dẫn trùng hoặc nhập nhằng.')
      }
      files.add(canonical)
    }
    if (files.size + directories.size > MAX_ENGINE_ENTRIES * 2) {
      throw new Error('Gói engine tạo ra quá nhiều đường dẫn.')
    }
    if (isSymlink) {
      if (size <= 0 || size > 4096) throw new Error('Symbolic link engine không hợp lệ.')
      const target = entry.getData().toString('utf8')
      const virtualRoot = resolve(sep, 'vgc-engine-archive')
      const resolvedTarget = resolve(virtualRoot, ...parts.slice(0, -1), target)
      if (
        !target ||
        target.includes('\0') ||
        target.startsWith('/') ||
        /^[a-z]:/i.test(target) ||
        (resolvedTarget !== virtualRoot && !resolvedTarget.startsWith(virtualRoot + sep))
      ) {
        throw new Error('Symbolic link engine trỏ ra ngoài gói.')
      }
      symlinks.add(canonical)
    }
    normalizedEntries.push({ name: canonical, symlink: isSymlink })
    unpacked += size
    if (unpacked > MAX_ENGINE_UNPACKED) throw new Error('Gói engine giải nén vượt giới hạn an toàn.')
  }
  for (const entry of normalizedEntries) {
    const parts = entry.name.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (symlinks.has(parts.slice(0, i).join('/'))) {
        throw new Error('Gói engine ghi file xuyên qua symbolic link.')
      }
    }
  }
}

async function removeAppleDouble(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
      await fs.rm(full, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await removeAppleDouble(full)
    }
  }
}

async function validateExtractedTree(root: string, allowSafeSymlinks: boolean): Promise<void> {
  const rootPath = resolve(root)
  let entries = 0
  let bytes = 0
  const scan = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      entries++
      if (entries > MAX_ENGINE_ENTRIES) throw new Error('Engine giải nén có quá nhiều file.')
      const full = join(dir, entry.name)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink()) {
        if (!allowSafeSymlinks) throw new Error('Engine giải nén chứa symbolic link.')
        const real = await fs.realpath(full)
        if (real !== rootPath && !real.startsWith(rootPath + sep)) {
          throw new Error('Symbolic link trong engine trỏ ra ngoài gói.')
        }
        continue
      }
      if (stat.isDirectory()) {
        await scan(full)
      } else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > MAX_ENGINE_UNPACKED) throw new Error('Engine giải nén vượt giới hạn an toàn.')
      } else {
        throw new Error('Engine giải nén chứa loại file không được hỗ trợ.')
      }
    }
  }
  await scan(rootPath)
}

function macSignatureMetadata(path: string): string | null {
  const details = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', path], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 256 * 1024
  })
  if (details.status !== 0) return null
  return `${details.stdout ?? ''}\n${details.stderr ?? ''}`
}

function verifyMacBundle(appPath: string): boolean {
  const verified = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { encoding: 'utf8', timeout: 30_000 }
  )
  if (verified.status !== 0) return false
  const metadata = macSignatureMetadata(appPath)
  const hostMetadata = macSignatureMetadata(process.execPath)
  const engineTeam = metadata?.match(/(?:^|\n)TeamIdentifier=([A-Z0-9]{10})(?:\n|$)/)?.[1]
  const hostTeam = hostMetadata?.match(/(?:^|\n)TeamIdentifier=([A-Z0-9]{10})(?:\n|$)/)?.[1]
  const developerId = metadata?.includes('Authority=Developer ID Application:') === true
  const hostDeveloperId = hostMetadata?.includes('Authority=Developer ID Application:') === true
  // Local Mac builds are intentionally ad-hoc sealed when a Developer ID certificate is not
  // available. Accept that only when both the host app and the pinned engine are ad-hoc; a
  // signed host still requires the same notarized Developer ID team as its engine.
  if (!developerId && !hostDeveloperId) {
    return Boolean(
      metadata?.includes('Signature=adhoc') && hostMetadata?.includes('Signature=adhoc')
    )
  }
  if (
    !metadata ||
    !hostMetadata ||
    !developerId ||
    !hostDeveloperId ||
    !engineTeam ||
    engineTeam !== hostTeam
  ) {
    return false
  }
  const gatekeeper = spawnSync(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'execute', '--verbose=4', appPath],
    { encoding: 'utf8', timeout: 30_000 }
  )
  return gatekeeper.status === 0
}

interface WindowsSignature {
  Status?: string
  Subject?: string
}

function windowsSignature(filePath: string): WindowsSignature | null {
  const escaped = filePath.replace(/'/g, "''")
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`
      ],
      { encoding: 'utf-8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }
    ).trim()
    return JSON.parse(output) as WindowsSignature
  } catch {
    return null
  }
}

function verifyWindowsBinary(exePath: string): boolean {
  if (process.platform !== 'win32') return true
  const dllPath = join(resolve(exePath, '..'), 'chrome.dll')
  if (engineRelease.windowsSigning === 'unsigned') {
    const isUnsignedPe = (filePath: string): boolean => {
      let fd: number | undefined
      try {
        fd = openSync(filePath, fsConstants.O_RDONLY)
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size < 256) return false
        const header = Buffer.alloc(Math.min(stat.size, 64 * 1024))
        const bytesRead = readSync(fd, header, 0, header.length, 0)
        if (bytesRead < 256 || header.readUInt16LE(0) !== 0x5a4d) return false
        const peOffset = header.readUInt32LE(0x3c)
        if (peOffset < 64 || peOffset + 24 > bytesRead) return false
        if (header.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return false
        const optionalHeader = peOffset + 24
        const magic = header.readUInt16LE(optionalHeader)
        const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1)
        const securityEntry = dataDirectory + 4 * 8
        return (
          dataDirectory >= optionalHeader &&
          securityEntry + 8 <= bytesRead &&
          header.readUInt32LE(securityEntry) === 0 &&
          header.readUInt32LE(securityEntry + 4) === 0
        )
      } catch {
        return false
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    }
    const fileHash = (filePath: string): string | null => {
      let fd: number | undefined
      try {
        fd = openSync(filePath, fsConstants.O_RDONLY)
        const hash = createHash('sha256')
        const chunk = Buffer.allocUnsafe(1024 * 1024)
        let bytesRead = 0
        while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          hash.update(chunk.subarray(0, bytesRead))
        }
        return hash.digest('hex')
      } catch {
        return null
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    }
    return Boolean(
      isUnsignedPe(exePath) &&
        isUnsignedPe(process.execPath) &&
        isUnsignedPe(dllPath) &&
        fileHash(exePath) === engineRelease.windowsFiles['chrome.exe'] &&
        fileHash(dllPath) === engineRelease.windowsFiles['chrome.dll']
    )
  }
  const engine = windowsSignature(exePath)
  const host = windowsSignature(process.execPath)
  const dll = windowsSignature(dllPath)
  return Boolean(
    engine?.Status === 'Valid' &&
      host?.Status === 'Valid' &&
      dll?.Status === 'Valid' &&
      engine.Subject &&
      engine.Subject === host.Subject &&
      dll.Subject === host.Subject
  )
}

function verifyEngineVersion(enginePath: string): boolean {
  try {
    let version = ''
    if (process.platform === 'win32') {
      const escaped = enginePath.replace(/'/g, "''")
      version = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`],
        { encoding: 'utf8', windowsHide: true }
      ).trim()
    } else if (process.platform === 'darwin') {
      const appPath = resolve(enginePath, '..', '..', '..')
      version = execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleShortVersionString', join(appPath, 'Contents', 'Info.plist')],
        { encoding: 'utf8' }
      ).trim()
    }
    return version === CHROME_BUILD.full
  } catch {
    return false
  }
}

async function readEngineManifest(path: string): Promise<{ url?: string; sha256?: string } | null> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) return null
    const parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as {
      url?: unknown
      sha256?: unknown
    }
    return {
      ...(typeof parsed.url === 'string' && parsed.url.length <= 2048 ? { url: parsed.url } : {}),
      ...(typeof parsed.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(parsed.sha256)
        ? { sha256: parsed.sha256.toLowerCase() }
        : {})
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeEngineManifest(
  path: string,
  manifest: { url: string; sha256: string }
): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(manifest, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fs.rename(temp, path)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

function engineParentDir(): string {
  return join(app.getPath('userData'), 'engine')
}

async function ensureEngineParent(): Promise<string> {
  const dir = engineParentDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Thư mục engine không an toàn.')
  }
  await fs.chmod(dir, 0o700).catch(() => {})
  return dir
}

export function engineDir(): string {
  return join(engineParentDir(), 'chromium')
}

export function downloadedEngineExe(): string {
  return join(engineDir(), 'chrome.exe')
}

export async function isEngineInstalled(): Promise<boolean> {
  if (!app.isPackaged && process.env.VGC_ENGINE_PATH && existsSync(process.env.VGC_ENGINE_PATH)) {
    return verifyEngineVersion(process.env.VGC_ENGINE_PATH)
  }
  const settings = await getSettings()
  const macCore = macVgcCoreEngine()
  if (macCore) {
    const root = resolve(macCore, '..', '..', '..')
    const manifest = await readEngineManifest(join(app.getPath('userData'), 'engine', 'mac-engine.json'))
    return Boolean(
      settings.engineHashMac &&
        manifest?.sha256 === settings.engineHashMac.toLowerCase() &&
        verifyMacBundle(root) &&
        verifyEngineVersion(macCore)
    )
  }
  const engine = resolveEnginePath()
  if (!engine) return false
  if (resolve(engine) === resolve(downloadedEngineExe())) {
    const settings = await getSettings()
    const manifest = await readEngineManifest(join(engineDir(), '.vgc-engine.json'))
    return Boolean(
      settings.engineHash &&
        manifest?.url === settings.engineUrl &&
        manifest.sha256 === settings.engineHash.toLowerCase() &&
        verifyWindowsBinary(engine) &&
        verifyEngineVersion(engine)
    )
  }
  return verifyWindowsBinary(engine) && verifyEngineVersion(engine)
}

/**
 * macOS: download + install the VGC Core engine zip (a built Chromium .app, made by
 * scripts/package-mac-engine.sh) into userData/engine/VGC Core.app and return its
 * binary path. The archive hash and nested code signatures are mandatory.
 */
async function downloadMacEngine(
  url: string,
  onProgress?: (p: EngineProgress) => void
): Promise<string | null> {
  // Arch guard: the engine is a native Mach-O. Installing an arm64 build on an
  // Intel Mac (or vice-versa) yields a binary that cannot launch. Refuse a mismatched
  // archive before installation; production never falls back to a stock browser.
  const wantsArm = /arm64|aarch64/i.test(url)
  const wantsIntel = /x86_64|x64|intel/i.test(url)
  if ((wantsArm && process.arch !== 'arm64') || (wantsIntel && process.arch !== 'x64')) {
    return null
  }

  const dir = await ensureEngineParent()
  const zipPath = join(dir, `.vgc-core-mac-${randomUUID()}.zip`)

  onProgress?.({ phase: 'check', message: 'Chuẩn bị tải engine VGC Core…' })
  await downloadFile(url, zipPath, onProgress)

  // Integrity check: the engine zip is executed as the browser, so a compromised host
  // or a MITM swapping it out = code execution. Verify its SHA-256 against the pinned
  // hash before touching it; on mismatch, delete and refuse (fall back to no engine).
  const wantHash = (await getSettings()).engineHashMac?.toLowerCase()
  const gotHash = await sha256File(zipPath).catch(() => '')
  if (!wantHash || gotHash !== wantHash) {
    onProgress?.({ phase: 'error', message: 'Engine tải về sai chữ ký (hash) — đã huỷ.' })
    await fs.unlink(zipPath).catch(() => {})
    return null
  }

  onProgress?.({ phase: 'extract', message: 'Đang giải nén engine…' })
  const appPath = join(dir, 'VGC Core.app')
  const staging = join(dir, `.staging-${randomUUID()}`)
  const stagedApp = join(staging, 'VGC Core.app')
  try {
    const zip = new AdmZip(zipPath)
    validateZip(zip, true)
    await fs.mkdir(staging, { recursive: true, mode: 0o700 })
    execFileSync('/usr/bin/ditto', ['--norsrc', '-x', '-k', zipPath, staging])
    if (!existsSync(join(stagedApp, 'Contents', 'MacOS', 'Chromium'))) {
      throw new Error('Gói engine macOS không có VGC Core.app đúng cấu trúc.')
    }
    await removeAppleDouble(stagedApp)
    await validateExtractedTree(stagedApp, true)
    if (!verifyMacBundle(stagedApp)) throw new Error('Engine macOS chưa ký Developer ID/notarize hợp lệ.')
    const stagedBin = join(stagedApp, 'Contents', 'MacOS', 'Chromium')
    if (!verifyEngineVersion(stagedBin)) throw new Error('Phiên bản VGC Core không khớp ứng dụng.')

    const backup = join(dir, `.backup-${randomUUID()}.app`)
    if (existsSync(appPath)) await fs.rename(appPath, backup)
    try {
      await fs.rename(stagedApp, appPath)
      await writeEngineManifest(
        join(dir, 'mac-engine.json'),
        { url, sha256: gotHash }
      )
      await fs.rm(backup, { recursive: true, force: true })
    } catch (error) {
      await fs.rm(appPath, { recursive: true, force: true })
      if (existsSync(backup)) await fs.rename(backup, appPath)
      throw error
    }
  } finally {
    await fs.unlink(zipPath).catch(() => {})
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
  onProgress?.({ phase: 'done', percent: 100, message: 'Engine VGC Core sẵn sàng' })
  return macVgcCoreEngine()
}

/** The engineUrlMac a downloaded Mac engine was installed from (empty if unknown,
 *  e.g. a locally-built engine on the build machine). Used to re-download when the
 *  hosted engine URL is bumped. */
async function installedMacEngineManifest(): Promise<{ url?: string; sha256?: string } | null> {
  return readEngineManifest(join(app.getPath('userData'), 'engine', 'mac-engine.json'))
}

/**
 * Returns a usable engine chrome.exe path, downloading VGC Core from the server
 * if it isn't installed yet. Production never falls back to stock Chrome because
 * it ignores the native --vgc-* switches and creates a contradictory fingerprint.
 */
export async function ensureEngine(
  onProgress?: (p: EngineProgress) => void
): Promise<string> {
  // 1. Explicit override (e.g. local dev build).
  const override = process.env.VGC_ENGINE_PATH
  if (!app.isPackaged && override && existsSync(override)) {
    if (!verifyEngineVersion(override)) throw new Error('VGC_ENGINE_PATH không đúng phiên bản VGC Core.')
    return override
  }

  // 2. macOS: prefer the locally-built VGC Core engine (own Dock icon, isolated from
  //    the user's Chrome, CDP works) over the system Chrome. But if the hosted engine
  //    URL was bumped since this copy was installed, re-download it — engine features
  //    (logo, badge, translate…) ship in the engine, so a URL bump must reach every
  //    machine. A locally-built engine writes its url file = engineUrlMac to opt out.
  const macCore = macVgcCoreEngine()
  if (macCore) {
    const settings = await getSettings()
    const wantUrl = settings.engineUrlMac || ''
    const wantHash = settings.engineHashMac?.toLowerCase() || ''
    const installed = await installedMacEngineManifest()
    if (
      wantUrl &&
      wantHash &&
      installed?.url === wantUrl &&
      installed.sha256 === wantHash &&
      verifyMacBundle(resolve(macCore, '..', '..', '..')) &&
      verifyEngineVersion(macCore)
    ) {
      return macCore
    }
    // else: stale/untracked → fall through to (re)download the newer engine.
  }

  // 3. Engine BUNDLED with the installer (electron-builder win.extraResources →
  //    resources/engine/chromium), BRANDED with the VGC logo by brand-engine.mjs at
  //    build time. Preferred OVER any older runtime-downloaded engine in userData:
  //    that copy is the RAW unbranded zip, so using it would still show the stock
  //    Chromium logo on Windows even after the app updates. A fresh machine also
  //    gets the engine immediately here, with NO 341MB download.
  const resolved = resolveEnginePath()
  if (
    resolved &&
    resolve(resolved) !== resolve(downloadedEngineExe()) &&
    isDedicatedEngine(resolved)
  ) {
    if (!verifyWindowsBinary(resolved) || !verifyEngineVersion(resolved)) {
      throw new Error('Tính toàn vẹn của VGC Core không hợp lệ. Hãy cài lại engine chính thức.')
    }
    return resolved
  }

  // 4. A previously runtime-downloaded engine in userData (only reached when no
  //    bundled engine is present — an old install or a dev run).
  if (existsSync(downloadedEngineExe())) {
    const sExisting = await getSettings()
    const manifest = await readEngineManifest(join(engineDir(), '.vgc-engine.json'))
    if (
      sExisting.engineHash &&
      manifest?.sha256 === sExisting.engineHash.toLowerCase() &&
      manifest.url === sExisting.engineUrl &&
      verifyWindowsBinary(downloadedEngineExe()) &&
      verifyEngineVersion(downloadedEngineExe())
    ) {
      return downloadedEngineExe()
    }
  }

  // 4. macOS: download the native VGC Core engine (a built Chromium .app) if it's
  //    hosted (settings.engineUrlMac) and not yet installed.
  if (process.platform === 'darwin') {
    const sMac = await getSettings()
    if (sMac.engineUrlMac && sMac.engineHashMac) {
      const dl = await downloadMacEngine(sMac.engineUrlMac, onProgress).catch(() => null)
      if (dl) return dl
    }
  }
  if (process.platform !== 'win32') {
    throw new Error(
      'Không tìm thấy VGC Core đã xác minh. VGC Browser không dùng Chrome hệ thống vì sẽ làm lộ vân tay máy thật.'
    )
  }

  const s = await getSettings()

  // Runtime engine downloads are fail-closed until the release manifest pins a hash.
  if (!s.engineUrl || !s.engineHash) {
    throw new Error('Bản phát hành chưa ghim SHA-256 cho engine Windows. Hãy cài lại bản có engine đi kèm.')
  }

  // 4. Download + extract from the server.
  onProgress?.({ phase: 'check', message: 'Chuẩn bị tải engine…' })
  const engineParent = await ensureEngineParent()
  const zipPath = join(engineParent, `.vgc-core-${randomUUID()}.zip`)

  await downloadFile(s.engineUrl, zipPath, onProgress)
  const gotHash = await sha256File(zipPath)
  if (gotHash !== s.engineHash.toLowerCase()) {
    await fs.unlink(zipPath).catch(() => {})
    throw new Error('SHA-256 của engine Windows không khớp manifest phát hành.')
  }

  onProgress?.({ phase: 'extract', message: 'Đang giải nén engine…' })
  const zip = new AdmZip(zipPath)
  validateZip(zip)
  const staging = join(engineParent, `.staging-${randomUUID()}`)
  await fs.mkdir(staging, { recursive: true, mode: 0o700 })
  try {
    zip.extractAllTo(staging, /* overwrite */ false)
    await validateExtractedTree(staging, false)
    const candidates: string[] = []
    const scan = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await scan(full)
        else if (entry.name.toLowerCase() === 'chrome.exe') candidates.push(full)
      }
    }
    await scan(staging)
    if (candidates.length !== 1) throw new Error('Gói engine phải chứa đúng một chrome.exe.')
    const sourceRoot = resolve(candidates[0], '..')
    const stagingRoot = resolve(staging)
    if (sourceRoot !== stagingRoot && !sourceRoot.startsWith(stagingRoot + sep)) {
      throw new Error('Đường dẫn engine không an toàn.')
    }
    if (!verifyWindowsBinary(candidates[0])) throw new Error('Tính toàn vẹn engine không hợp lệ.')
    if (!verifyEngineVersion(candidates[0])) throw new Error('Phiên bản VGC Core không khớp ứng dụng.')
    const target = engineDir()
    const backup = join(engineParent, `.backup-${randomUUID()}`)
    if (existsSync(target)) await fs.rename(target, backup)
    try {
      await fs.rename(sourceRoot, target)
      await writeEngineManifest(join(target, '.vgc-engine.json'), {
        url: s.engineUrl,
        sha256: s.engineHash.toLowerCase()
      })
      await fs.rm(backup, { recursive: true, force: true })
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      if (existsSync(backup)) await fs.rename(backup, target)
      throw error
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    await fs.unlink(zipPath).catch(() => {})
  }

  if (!existsSync(downloadedEngineExe())) {
    // Zip may have a top-level folder — find chrome.exe and note it.
    throw new Error('Giải nén xong nhưng không thấy chrome.exe (kiểm tra cấu trúc zip engine).')
  }

  onProgress?.({ phase: 'done', percent: 100, message: 'Engine sẵn sàng' })
  return downloadedEngineExe()
}
