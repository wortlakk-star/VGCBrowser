// Fetch and verify the pinned Windows VGC Core before packaging it with the app.
import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { lstat, readdir } from 'node:fs/promises'
import AdmZip from 'adm-zip'

const MAX_DOWNLOAD = 1_500 * 1024 * 1024
const MAX_UNPACKED = 4 * 1024 * 1024 * 1024
const MAX_ENTRY = 1_500 * 1024 * 1024
const MAX_ENTRIES = 30_000
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const ENGINE_URL = process.env.VGC_ENGINE_URL || 'https://vgcbrowser.com/dl/vgc-core-157.zip'
const ENGINE_HASH = (process.env.VGC_ENGINE_SHA256 || '').trim().toLowerCase()
const ENGINE_SIGNER = (process.env.VGC_WINDOWS_SIGNER_SUBJECT || '').trim()
const ALLOW_UNSIGNED = process.env.VGC_ALLOW_UNSIGNED_BUILD === '1'

const root = process.cwd()
const release = JSON.parse(readFileSync(join(root, 'src', 'shared', 'engine-release.json'), 'utf8'))
const ENGINE_VERSION = String(release.chromeVersion || '')
const engineDir = join(root, 'engine')
const outDir = join(engineDir, 'chromium')
const zipPath = join(engineDir, `.vgc-core-${randomUUID()}.zip`)
const staging = join(engineDir, `.staging-${randomUUID()}`)
const manifestPath = join(outDir, '.vgc-engine.json')

function assertReleaseInputs() {
  const url = new URL(ENGINE_URL)
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
    throw new Error('VGC_ENGINE_URL phải thuộc https://vgcbrowser.com/dl/.')
  }
  if (!/^[a-f0-9]{64}$/.test(ENGINE_HASH)) {
    throw new Error('Thiếu VGC_ENGINE_SHA256 hợp lệ; không được build release với engine chưa ghim hash.')
  }
  if (ALLOW_UNSIGNED && ENGINE_SIGNER) {
    throw new Error('Không được đặt signer khi đang build unsigned.')
  }
  if (!ALLOW_UNSIGNED && (!ENGINE_SIGNER || ENGINE_SIGNER.length > 1024)) {
    throw new Error('Thiếu VGC_WINDOWS_SIGNER_SUBJECT; không được tin một chữ ký Authenticode bất kỳ.')
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ENGINE_VERSION)) {
    throw new Error('Manifest phiên bản engine không hợp lệ.')
  }
  if (
    release.windowsSigning !== (ALLOW_UNSIGNED ? 'unsigned' : 'signed') ||
    !/^[a-f0-9]{64}$/.test(release.windowsFiles?.['chrome.exe'] || '') ||
    !/^[a-f0-9]{64}$/.test(release.windowsFiles?.['chrome.dll'] || '')
  ) {
    throw new Error('Manifest chữ ký hoặc hash file engine không khớp chế độ release.')
  }
  return url
}

function verifyAuthenticode(exe) {
  if (process.platform !== 'win32') {
    throw new Error('Đóng gói engine Windows phải chạy trên Windows để xác minh Authenticode.')
  }
  const escaped = exe.replace(/'/g, "''")
  const signature = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 }
    )
  )
  if (ALLOW_UNSIGNED) {
    if (signature.Status !== 'NotSigned' || signature.Subject) {
      throw new Error('Engine phải hoàn toàn unsigned trong chế độ release unsigned.')
    }
    return
  }
  if (signature.Status !== 'Valid' || signature.Subject !== ENGINE_SIGNER) {
    throw new Error('Engine không do đúng nhà phát hành Authenticode ký.')
  }
}

function verifyEngineVersion(exe) {
  const escaped = exe.replace(/'/g, "''")
  const version = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  if (version !== ENGINE_VERSION) {
    throw new Error(`Engine ${version || '<unknown>'} không khớp manifest ${ENGINE_VERSION}.`)
  }
}

function validateZip(zip) {
  const entries = zip.getEntries()
  if (!entries.length || entries.length > MAX_ENTRIES) throw new Error('Số entry trong ZIP engine không hợp lệ.')
  const files = new Set()
  const directories = new Set()
  let unpacked = 0
  for (const entry of entries) {
    const rawName = entry.entryName
    const name = rawName.replace(/\\/g, '/').replace(entry.isDirectory ? /\/$/ : /$^/, '')
    const parts = name.split('/')
    const mode = entry.header.fileAttr & 0o170000
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
      size > MAX_ENTRY ||
      ![0, 0o040000, 0o100000].includes(mode) ||
      (entry.isDirectory && mode === 0o100000) ||
      (!entry.isDirectory && mode === 0o040000)
    ) {
      throw new Error(`Entry ZIP engine không an toàn: ${name || '<empty>'}`)
    }
    const canonicalParts = parts.map((part) => part.normalize('NFC').toLowerCase())
    const canonical = canonicalParts.join('/')
    for (let i = 1; i < canonicalParts.length; i++) {
      const parent = canonicalParts.slice(0, i).join('/')
      if (files.has(parent)) throw new Error('ZIP engine chứa xung đột file/thư mục.')
      directories.add(parent)
    }
    if (entry.isDirectory) {
      if (files.has(canonical)) throw new Error('ZIP engine chứa xung đột file/thư mục.')
      directories.add(canonical)
    } else {
      if (files.has(canonical) || directories.has(canonical)) {
        throw new Error('ZIP engine chứa đường dẫn trùng hoặc nhập nhằng.')
      }
      files.add(canonical)
    }
    if (files.size + directories.size > MAX_ENTRIES * 2) {
      throw new Error('ZIP engine tạo ra quá nhiều đường dẫn.')
    }
    unpacked += size
    if (unpacked > MAX_UNPACKED) throw new Error('ZIP engine vượt giới hạn giải nén an toàn.')
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyEngineFileHashes(exe, dll) {
  return (
    (await sha256(exe)) === release.windowsFiles['chrome.exe'] &&
    (await sha256(dll)) === release.windowsFiles['chrome.dll']
  )
}

async function download(url) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15 * 60_000)
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Tải engine lỗi: HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_DOWNLOAD) {
    await response.body.cancel().catch(() => {})
    throw new Error('Engine vượt giới hạn tải an toàn.')
  }
  let received = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      callback(received > MAX_DOWNLOAD ? new Error('Engine vượt giới hạn tải an toàn.') : null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(response.body),
    limiter,
    createWriteStream(zipPath, { mode: 0o600, flags: 'wx' })
  )
}

async function validateExtractedTree(dir) {
  let entries = 0
  let bytes = 0
  const scan = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      entries++
      if (entries > MAX_ENTRIES) throw new Error('Engine giải nén có quá nhiều file.')
      const full = join(current, entry.name)
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) throw new Error('Engine Windows không được chứa symbolic link.')
      if (stat.isDirectory()) await scan(full)
      else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > MAX_UNPACKED) throw new Error('Engine giải nén vượt giới hạn an toàn.')
      } else {
        throw new Error('Engine chứa loại file không được hỗ trợ.')
      }
    }
  }
  await scan(dir)
}

const url = assertReleaseInputs()
mkdirSync(engineDir, { recursive: true })

if (existsSync(join(outDir, 'chrome.exe')) && existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.sha256 === ENGINE_HASH && manifest.url === url.href) {
      const exe = join(outDir, 'chrome.exe')
      const dll = join(outDir, 'chrome.dll')
      verifyAuthenticode(exe)
      verifyAuthenticode(dll)
      verifyEngineVersion(exe)
      if (!(await verifyEngineFileHashes(exe, dll))) throw new Error('Hash file engine không khớp.')
      console.log('Engine đã có sẵn, đúng hash, phiên bản và chế độ chữ ký.')
      process.exit(0)
    }
  } catch {
    // Re-fetch below; stale or unverifiable local engine must not be bundled.
  }
}

try {
  console.log(`Đang tải engine đã ghim: ${url.href}`)
  await download(url)
  const gotHash = await sha256(zipPath)
  if (gotHash !== ENGINE_HASH) throw new Error(`SHA-256 không khớp: nhận ${gotHash}`)

  const zip = new AdmZip(zipPath)
  validateZip(zip)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  zip.extractAllTo(staging, false)

  const exe = join(staging, 'chrome.exe')
  const dll = join(staging, 'chrome.dll')
  if (!existsSync(exe)) throw new Error('ZIP engine phải đặt chrome.exe tại thư mục gốc.')
  const resolvedExe = resolve(exe)
  if (!resolvedExe.startsWith(resolve(staging) + sep)) throw new Error('Đường dẫn chrome.exe không an toàn.')
  await validateExtractedTree(staging)
  verifyAuthenticode(exe)
  verifyAuthenticode(dll)
  verifyEngineVersion(exe)
  if (!(await verifyEngineFileHashes(exe, dll))) throw new Error('Hash file engine không khớp manifest.')

  const backup = `${outDir}.old-${randomUUID()}`
  if (existsSync(outDir)) renameSync(outDir, backup)
  try {
    renameSync(staging, outDir)
    writeFileSync(manifestPath, JSON.stringify({ url: url.href, sha256: ENGINE_HASH }, null, 2), {
      mode: 0o600
    })
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true })
    if (existsSync(backup)) renameSync(backup, outDir)
    throw error
  }
  console.log('Engine Windows đã được xác minh hash, phiên bản và sẵn sàng để đóng gói.')
} finally {
  rmSync(zipPath, { force: true })
  rmSync(staging, { recursive: true, force: true })
}
