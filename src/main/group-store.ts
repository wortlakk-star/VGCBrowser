import { app } from 'electron'
import { join } from 'path'
import { accountKey } from './session'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'
import { cleanText } from './validation'

interface GroupStorePaths {
  encrypted: string
  legacy: string
}

function storePaths(key = accountKey()): GroupStorePaths {
  const dir = join(app.getPath('userData'), 'db')
  return {
    encrypted: join(dir, `groups-${key}.enc`),
    legacy: join(dir, `groups-${key}.json`)
  }
}

function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((name) => cleanText(name, 120).trim()).filter(Boolean))].slice(0, 500)
}

async function listGroupsAt(paths: GroupStorePaths): Promise<string[]> {
  const groups =
    (await readSecureJson<unknown>(paths.encrypted)) ??
    (await migratePlainJson<unknown>(paths.encrypted, paths.legacy))
  return normalize(groups)
}

export function listGroups(): Promise<string[]> {
  const paths = storePaths()
  return mutate(paths, () => listGroupsAt(paths))
}

const mutationChains = new Map<string, Promise<unknown>>()
function mutate<T>(paths: GroupStorePaths, fn: () => Promise<T>): Promise<T> {
  const previous = mutationChains.get(paths.encrypted) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  mutationChains.set(paths.encrypted, settled)
  void settled.finally(() => {
    if (mutationChains.get(paths.encrypted) === settled) mutationChains.delete(paths.encrypted)
  })
  return run
}

async function writeAt(paths: GroupStorePaths, groups: string[]): Promise<void> {
  await writeSecureJson(paths.encrypted, normalize(groups))
}

export async function createGroup(name: string): Promise<string[]> {
  const n = cleanText(name, 120).trim()
  const paths = storePaths()
  return mutate(paths, async () => {
    const groups = await listGroupsAt(paths)
    if (n && !groups.includes(n)) groups.push(n)
    await writeAt(paths, groups)
    return groups
  })
}

export async function deleteGroup(name: string): Promise<string[]> {
  const target = cleanText(name, 120).trim()
  const paths = storePaths()
  return mutate(paths, async () => {
    const groups = (await listGroupsAt(paths)).filter((group) => group !== target)
    await writeAt(paths, groups)
    return groups
  })
}
