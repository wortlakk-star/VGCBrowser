import { safeStorage } from 'electron'
import { constants as fsConstants, promises as fs } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'

export function requireSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Kho bảo mật của hệ điều hành chưa sẵn sàng. VGC Browser sẽ không ghi thông tin nhạy cảm dạng plaintext.'
    )
  }
  const backend = (
    safeStorage as typeof safeStorage & { getSelectedStorageBackend?: () => string }
  ).getSelectedStorageBackend?.()
  if (backend === 'basic_text') {
    throw new Error('Kho bảo mật Linux đang dùng basic_text; cần GNOME Keyring/KWallet trước khi lưu bí mật.')
  }
}

async function ensurePrivateParent(filePath: string): Promise<void> {
  const parent = dirname(filePath)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(parent)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Thư mục kho bảo mật không hợp lệ')
  }
  await fs.chmod(parent, 0o700).catch(() => {})
}

async function readPrivateFile(filePath: string, maxBytes: number): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
      throw new Error('File kho bảo mật không hợp lệ')
    }
    await handle.chmod(0o600).catch(() => {})
    return await handle.readFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function readSecureJson<T>(filePath: string): Promise<T | null> {
  const encrypted = await readPrivateFile(filePath, 64 * 1024 * 1024)
  if (!encrypted) return null
  requireSafeStorage()
  return JSON.parse(safeStorage.decryptString(encrypted)) as T
}

const writeChains = new Map<string, Promise<void>>()

export function writeSecureJson(filePath: string, value: unknown): Promise<void> {
  const previous = writeChains.get(filePath) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    requireSafeStorage()
    await ensurePrivateParent(filePath)
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    const serialized = JSON.stringify(value, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024 * 1024) {
      throw new Error('Dữ liệu bảo mật vượt giới hạn 64 MB')
    }
    const encrypted = safeStorage.encryptString(serialized)
    try {
      await fs.writeFile(tempPath, encrypted, { mode: 0o600, flag: 'wx' })
      await fs.rename(tempPath, filePath)
    } finally {
      await fs.unlink(tempPath).catch(() => {})
    }
  })
  writeChains.set(filePath, run)
  void run.finally(() => {
    if (writeChains.get(filePath) === run) writeChains.delete(filePath)
  }).catch(() => {})
  return run
}

export async function migratePlainJson<T>(
  encryptedPath: string,
  legacyPath: string
): Promise<T | null> {
  const plaintext = await readPrivateFile(legacyPath, 64 * 1024 * 1024)
  if (!plaintext) return null
  const parsed = JSON.parse(plaintext.toString('utf8')) as T
  await writeSecureJson(encryptedPath, parsed)
  await fs.unlink(legacyPath).catch(() => {})
  return parsed
}
