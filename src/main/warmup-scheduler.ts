import { app } from 'electron'
import { join } from 'path'
import { runWarmup } from './rpa'
import { getProfile } from './store'
import { accountKey } from './session'
import type { WarmSchedule } from '../shared/types'
import { migratePlainJson, readSecureJson, writeSecureJson } from './secure-store'
import { requireProfileIds } from './validation'
import { runAccountOperation } from './account-operations'

const DEFAULTS: WarmSchedule = { enabled: false, profileIds: [], everyHours: 12, minutes: 2 }

interface SchedulePaths {
  encrypted: string
  legacy: string
}

function schedulePaths(key = accountKey()): SchedulePaths {
  const dir = app.getPath('userData')
  return {
    encrypted: join(dir, `warm-schedule-${key}.enc`),
    legacy: join(dir, `warm-schedule-${key}.json`)
  }
}

function normalize(value: unknown): WarmSchedule {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<WarmSchedule>)
    : {}
  let profileIds: string[] = []
  try {
    profileIds = requireProfileIds(input.profileIds ?? [], 100)
  } catch {
    profileIds = []
  }
  const everyHours = Math.max(1, Math.min(168, Number(input.everyHours) || DEFAULTS.everyHours))
  const minutes = Math.max(1, Math.min(120, Number(input.minutes) || DEFAULTS.minutes))
  const lastRun =
    typeof input.lastRun === 'string' && Number.isFinite(Date.parse(input.lastRun))
      ? new Date(input.lastRun).toISOString()
      : undefined
  return {
    enabled: input.enabled === true,
    profileIds,
    everyHours,
    minutes,
    ...(lastRun ? { lastRun } : {})
  }
}

async function getScheduleAt(paths: SchedulePaths): Promise<WarmSchedule> {
  const stored =
    (await readSecureJson<unknown>(paths.encrypted)) ??
    (await migratePlainJson<unknown>(paths.encrypted, paths.legacy))
  return normalize(stored ?? DEFAULTS)
}

export function getSchedule(): Promise<WarmSchedule> {
  const paths = schedulePaths()
  return serializeSchedule(paths, () => getScheduleAt(paths))
}

const scheduleWriteChains = new Map<string, Promise<unknown>>()

function serializeSchedule<T>(paths: SchedulePaths, fn: () => Promise<T>): Promise<T> {
  const previous = scheduleWriteChains.get(paths.encrypted) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  scheduleWriteChains.set(paths.encrypted, settled)
  void settled.finally(() => {
    if (scheduleWriteChains.get(paths.encrypted) === settled) {
      scheduleWriteChains.delete(paths.encrypted)
    }
  })
  return run
}

export async function setSchedule(patch: Partial<WarmSchedule>): Promise<WarmSchedule> {
  const paths = schedulePaths()
  return serializeSchedule(paths, async () => {
    const next = normalize({ ...(await getScheduleAt(paths)), ...patch })
    await writeSecureJson(paths.encrypted, next)
    return next
  })
}

let timer: ReturnType<typeof setInterval> | null = null
let running = false

async function tickForAccount(): Promise<void> {
  if (running) return
  const key0 = accountKey()
  const cfg = await getSchedule()
  if (!cfg.enabled || !cfg.profileIds.length) return
  const due =
    !cfg.lastRun || Date.now() - Date.parse(cfg.lastRun) >= Math.max(1, cfg.everyHours) * 3600_000
  if (!due) return
  running = true
  try {
    for (const id of cfg.profileIds) {
      if (accountKey() !== key0) return
      const prof = await getProfile(id)
      if (!prof) continue
      await runWarmup(id, prof.name, { minutes: cfg.minutes }, () => {})
    }
    if (accountKey() === key0) await setSchedule({ lastRun: new Date().toISOString() })
  } catch {
    // A scheduled run must not crash the app.
  } finally {
    running = false
  }
}

async function tick(): Promise<void> {
  try {
    await runAccountOperation(tickForAccount)
  } catch {
    // Account transitions temporarily reject new scheduled work.
  }
}

export function startScheduler(): void {
  if (timer) return
  timer = setInterval(() => void tick(), 5 * 60 * 1000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
