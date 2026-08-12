import { app } from 'electron'
import { join } from 'path'
import { readSecureJson, writeSecureJson } from './secure-store'

const ALLOWED_KEY = 'vgc-cloud-auth'

function file(): string {
  return join(app.getPath('userData'), 'cloud-auth.enc')
}

async function readAll(): Promise<Record<string, string>> {
  const value = await readSecureJson<unknown>(file())
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const auth = (value as Record<string, unknown>)[ALLOWED_KEY]
  return typeof auth === 'string' && auth.length <= 256 * 1024 ? { [ALLOWED_KEY]: auth } : {}
}

let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(
    () => {},
    () => {}
  )
  return run
}

export async function getCloudAuth(key: string): Promise<string | null> {
  if (key !== ALLOWED_KEY) return null
  return (await readAll())[key] ?? null
}

export async function setCloudAuth(key: string, value: string): Promise<void> {
  if (key !== ALLOWED_KEY || typeof value !== 'string' || value.length > 256 * 1024) {
    throw new Error('Cloud auth payload không hợp lệ')
  }
  await serialize(() => writeSecureJson(file(), { [key]: value }))
}

export async function removeCloudAuth(key: string): Promise<void> {
  if (key !== ALLOWED_KEY) return
  await serialize(() => writeSecureJson(file(), {}))
}
