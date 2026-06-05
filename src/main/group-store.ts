// ── VGC Browser — profile groups (per account) ──────────────────────────────
// A persistent list of group (folder) names so empty groups still show in the
// sidebar. Scoped per account (by Supabase uid) like the profile store.

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { accountKey } from './session'

function file(): string {
  return join(app.getPath('userData'), 'db', `groups-${accountKey()}.json`)
}

export async function listGroups(): Promise<string[]> {
  try {
    const arr = JSON.parse(await fs.readFile(file(), 'utf-8'))
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

async function write(groups: string[]): Promise<void> {
  await fs.mkdir(join(app.getPath('userData'), 'db'), { recursive: true })
  await fs.writeFile(file(), JSON.stringify([...new Set(groups)], null, 2), 'utf-8')
}

export async function createGroup(name: string): Promise<string[]> {
  const n = name.trim()
  const groups = await listGroups()
  if (n && !groups.includes(n)) groups.push(n)
  await write(groups)
  return groups
}

export async function deleteGroup(name: string): Promise<string[]> {
  const groups = (await listGroups()).filter((g) => g !== name)
  await write(groups)
  return groups
}
