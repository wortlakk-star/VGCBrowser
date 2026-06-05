// ── VGC Browser — saved proxy store ──────────────────────────────────────────
// A reusable list of proxies (the "Proxy Manager"), stored as JSON in userData.
// Profiles reference proxies by copying their config; this store is just the
// library you pick from / import bought proxies into.

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { SavedProxy } from '../shared/types'

function file(): string {
  return join(app.getPath('userData'), 'db', 'proxies.json')
}

async function ensure(): Promise<void> {
  await fs.mkdir(join(app.getPath('userData'), 'db'), { recursive: true })
  try {
    await fs.access(file())
  } catch {
    await fs.writeFile(file(), '[]', 'utf-8')
  }
}

export async function listProxies(): Promise<SavedProxy[]> {
  await ensure()
  try {
    return JSON.parse(await fs.readFile(file(), 'utf-8')) as SavedProxy[]
  } catch {
    return []
  }
}

async function writeAll(list: SavedProxy[]): Promise<void> {
  await ensure()
  await fs.writeFile(file(), JSON.stringify(list, null, 2), 'utf-8')
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
