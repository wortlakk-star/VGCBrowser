// ── VGC Browser — saved proxy store ──────────────────────────────────────────
// A reusable list of proxies (the "Proxy Manager"), stored as JSON in userData.
// Profiles reference proxies by copying their config; this store is just the
// library you pick from / import bought proxies into.
//
// Scoped PER ACCOUNT (by Supabase uid, like profiles) so logging in with a
// different email shows only that account's proxies, and so the pool can sync to
// the cloud per account.

import { app } from 'electron'
import { join } from 'path'
import type { SavedProxy } from '../shared/types'
import { accountKey } from './session'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'
import { sanitizeSavedProxy } from './validation'

function dir(): string {
  return join(app.getPath('userData'), 'db')
}
interface ProxyStorePaths {
  encrypted: string
  accountLegacy: string
  globalLegacy: string
}

// Pre-per-account builds stored a single shared db/proxies.json. Read it as a
// fallback so existing proxies aren't lost; it migrates to the per-account file on
// the next write.
function storePaths(key = accountKey()): ProxyStorePaths {
  return {
    encrypted: join(dir(), `proxies-${key}.enc`),
    accountLegacy: join(dir(), `proxies-${key}.json`),
    globalLegacy: join(dir(), 'proxies.json')
  }
}

// Serialize every read-modify-write (like the profile store) so a cloud auto-pull's
// saveMany can't interleave with a user's saveProxy/delete and lose one another's
// changes by both reading the same list and overwriting the whole file.
const writeChains = new Map<string, Promise<unknown>>()
function serialize<T>(paths: ProxyStorePaths, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(paths.encrypted) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => {},
    () => {}
  )
  writeChains.set(paths.encrypted, settled)
  void settled.finally(() => {
    if (writeChains.get(paths.encrypted) === settled) writeChains.delete(paths.encrypted)
  })
  return run
}

async function writeAllAt(paths: ProxyStorePaths, list: SavedProxy[]): Promise<void> {
  await writeSecureJson(paths.encrypted, list)
}

async function listProxiesAt(paths: ProxyStorePaths): Promise<SavedProxy[]> {
  const encrypted = await readSecureJson<unknown>(paths.encrypted)
  const raw =
    encrypted ??
    (await migratePlainJson<unknown>(paths.encrypted, paths.accountLegacy)) ??
    (await migratePlainJson<unknown>(paths.encrypted, paths.globalLegacy)) ??
    []
  if (!Array.isArray(raw)) throw new Error('Kho proxy không đúng định dạng')
  return raw.map(sanitizeSavedProxy).filter((proxy): proxy is SavedProxy => proxy !== null).slice(0, 10_000)
}

export function listProxies(): Promise<SavedProxy[]> {
  const paths = storePaths()
  return serialize(paths, () => listProxiesAt(paths))
}

export async function saveProxy(p: SavedProxy): Promise<SavedProxy> {
  // A local edit (assign/rename/check) — stamp a fresh updatedAt so a subsequent cloud
  // pull recognises it as newer and doesn't overwrite it with a stale cloud copy.
  const normalized = sanitizeSavedProxy(p)
  if (!normalized) throw new Error('Proxy không hợp lệ')
  const stamped: SavedProxy = { ...normalized, updatedAt: new Date().toISOString() }
  const paths = storePaths()
  return serialize(paths, async () => {
    const all = await listProxiesAt(paths)
    const idx = all.findIndex((x) => x.id === stamped.id)
    if (idx >= 0) all[idx] = stamped
    else all.push(stamped)
    await writeAllAt(paths, all)
    return stamped
  })
}

export async function saveManyProxies(items: SavedProxy[]): Promise<number> {
  const paths = storePaths()
  return serialize(paths, async () => {
    if (!Array.isArray(items) || items.length > 10_000) throw new Error('Danh sách proxy không hợp lệ')
    const safeItems = items
      .map(sanitizeSavedProxy)
      .filter((proxy): proxy is SavedProxy => proxy !== null)
    const all = await listProxiesAt(paths)
    const byId = new Map(all.map((x) => [x.id, x]))
    for (const p of safeItems) {
      const it: SavedProxy = { ...p, updatedAt: p.updatedAt ?? new Date().toISOString() }
      const existing = byId.get(it.id)
      // Newer-wins: an incoming (e.g. cloud-pull) copy only overwrites a local one when
      // it's at least as new. New ids are always added; import/generate stamp `now`.
      if (!existing || !existing.updatedAt || (it.updatedAt ?? '') >= existing.updatedAt) {
        byId.set(it.id, it)
      }
    }
    await writeAllAt(paths, [...byId.values()].slice(0, 10_000))
    return safeItems.length
  })
}

export async function deleteProxy(id: string): Promise<void> {
  const paths = storePaths()
  return serialize(paths, async () => {
    const all = await listProxiesAt(paths)
    await writeAllAt(paths, all.filter((p) => p.id !== id))
  })
}

/**
 * Remove many proxies at once by id. Used by the cloud pull to apply deletions made
 * on another machine (tombstoned rows), so a proxy removed on one machine doesn't
 * keep coming back on every "Làm mới".
 */
export async function removeManyProxies(ids: string[]): Promise<void> {
  if (!ids.length) return
  const paths = storePaths()
  return serialize(paths, async () => {
    const all = await listProxiesAt(paths)
    const set = new Set(ids)
    const next = all.filter((p) => !set.has(p.id))
    if (next.length !== all.length) await writeAllAt(paths, next)
  })
}
