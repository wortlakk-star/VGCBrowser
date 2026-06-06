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
  const all = await listProxies()
  const idx = all.findIndex((x) => x.id === p.id)
  if (idx >= 0) all[idx] = p
  else all.push(p)
  await writeAll(all)
  return p
}

export async function saveManyProxies(items: SavedProxy[]): Promise<number> {
  const all = await listProxies()
  const byId = new Map(all.map((x) => [x.id, x]))
  for (const p of items) byId.set(p.id, p)
  await writeAll([...byId.values()])
  return items.length
}

export async function deleteProxy(id: string): Promise<void> {
  const all = await listProxies()
  await writeAll(all.filter((p) => p.id !== id))
}
