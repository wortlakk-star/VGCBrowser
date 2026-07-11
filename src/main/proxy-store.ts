// ── VGC Browser — saved proxy store ──────────────────────────────────────────
// A reusable list of proxies (the "Proxy Manager"), stored as JSON in userData.
// Profiles reference proxies by copying their config; this store is just the
// library you pick from / import bought proxies into.
//
// Scoped PER ACCOUNT (by Supabase uid, like profiles) so logging in with a
// different email shows only that account's proxies, and so the pool can sync to
// the cloud per account.

import { app } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import type { SavedProxy } from '../shared/types'
import { accountKey } from './session'

function dir(): string {
  return join(app.getPath('userData'), 'db')
}
function file(): string {
  return join(dir(), `proxies-${accountKey()}.json`)
}
// Pre-per-account builds stored a single shared db/proxies.json. Read it as a
// fallback so existing proxies aren't lost; it migrates to the per-account file on
// the next write.
function legacyFile(): string {
  return join(dir(), 'proxies.json')
}

// Serialize every read-modify-write (like the profile store) so a cloud auto-pull's
// saveMany can't interleave with a user's saveProxy/delete and lose one another's
// changes by both reading the same list and overwriting the whole file.
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(
    () => {},
    () => {}
  )
  return run
}

async function writeAll(list: SavedProxy[]): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(list, null, 2), 'utf-8')
}

export async function listProxies(): Promise<SavedProxy[]> {
  await fs.mkdir(dir(), { recursive: true })
  const f = existsSync(file()) ? file() : existsSync(legacyFile()) ? legacyFile() : null
  if (!f) return []
  try {
    return JSON.parse(await fs.readFile(f, 'utf-8')) as SavedProxy[]
  } catch {
    return []
  }
}

export async function saveProxy(p: SavedProxy): Promise<SavedProxy> {
  // A local edit (assign/rename/check) — stamp a fresh updatedAt so a subsequent cloud
  // pull recognises it as newer and doesn't overwrite it with a stale cloud copy.
  const stamped: SavedProxy = { ...p, updatedAt: new Date().toISOString() }
  return serialize(async () => {
    const all = await listProxies()
    const idx = all.findIndex((x) => x.id === stamped.id)
    if (idx >= 0) all[idx] = stamped
    else all.push(stamped)
    await writeAll(all)
    return stamped
  })
}

export async function saveManyProxies(items: SavedProxy[]): Promise<number> {
  return serialize(async () => {
    const all = await listProxies()
    const byId = new Map(all.map((x) => [x.id, x]))
    for (const p of items) {
      const it: SavedProxy = { ...p, updatedAt: p.updatedAt ?? new Date().toISOString() }
      const existing = byId.get(it.id)
      // Newer-wins: an incoming (e.g. cloud-pull) copy only overwrites a local one when
      // it's at least as new. New ids are always added; import/generate stamp `now`.
      if (!existing || !existing.updatedAt || (it.updatedAt ?? '') >= existing.updatedAt) {
        byId.set(it.id, it)
      }
    }
    await writeAll([...byId.values()])
    return items.length
  })
}

export async function deleteProxy(id: string): Promise<void> {
  return serialize(async () => {
    const all = await listProxies()
    await writeAll(all.filter((p) => p.id !== id))
  })
}

/**
 * Remove many proxies at once by id. Used by the cloud pull to apply deletions made
 * on another machine (tombstoned rows), so a proxy removed on one machine doesn't
 * keep coming back on every "Làm mới".
 */
export async function removeManyProxies(ids: string[]): Promise<void> {
  if (!ids.length) return
  return serialize(async () => {
    const all = await listProxies()
    const set = new Set(ids)
    const next = all.filter((p) => !set.has(p.id))
    if (next.length !== all.length) await writeAll(next)
  })
}
