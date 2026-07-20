// ── VGC Browser — scheduled auto warm-up ─────────────────────────────────────
// Persists a per-account warm-up schedule and, while the app is running, opens the listed
// profiles for a human-like Gmail session every `everyHours`. Config is stored per Supabase
// account so switching login shows that account's schedule. The runner is rpa.ts::runWarmup.
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { runWarmup } from './rpa'
import { getProfile } from './store'
import { accountKey } from './session'
import type { WarmSchedule } from '../shared/types'

const DEFAULTS: WarmSchedule = { enabled: false, profileIds: [], everyHours: 12, minutes: 2 }

function file(): string {
  return join(app.getPath('userData'), `warm-schedule-${accountKey()}.json`)
}

/** Load the CURRENT account's schedule from disk (fresh each call — the account can change). */
export function getSchedule(): WarmSchedule {
  try {
    const f = file()
    if (existsSync(f)) return { ...DEFAULTS, ...(JSON.parse(readFileSync(f, 'utf-8')) as WarmSchedule) }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULTS }
}

export function setSchedule(patch: Partial<WarmSchedule>): WarmSchedule {
  const next = { ...getSchedule(), ...patch }
  try {
    writeFileSync(file(), JSON.stringify(next))
  } catch {
    /* best-effort */
  }
  return next
}

let timer: ReturnType<typeof setInterval> | null = null
let running = false

async function tick(): Promise<void> {
  if (running) return // a previous scheduled batch is still going
  // Pin the batch to the account that was signed in when it began — file()/getProfile/setSchedule
  // all key off the CURRENT account, so if the user switches Supabase accounts mid-run we'd
  // otherwise read the wrong profile store and stamp lastRun onto the wrong account's schedule.
  const key0 = accountKey()
  const cfg = getSchedule()
  if (!cfg.enabled || !cfg.profileIds.length) return
  const due =
    !cfg.lastRun || Date.now() - Date.parse(cfg.lastRun) >= Math.max(1, cfg.everyHours) * 3600_000
  if (!due) return
  running = true
  try {
    for (const id of cfg.profileIds) {
      if (accountKey() !== key0) return // account switched mid-batch → abort
      const prof = await getProfile(id)
      if (!prof) continue
      // eslint-disable-next-line no-await-in-loop -- run one profile at a time (sequential)
      await runWarmup(id, prof.name, { minutes: cfg.minutes }, () => {})
    }
    // Only stamp lastRun if we're still on the account this batch actually ran for.
    if (accountKey() === key0) setSchedule({ lastRun: new Date().toISOString() })
  } catch {
    /* never let a scheduled run crash the app */
  } finally {
    running = false
  }
}

/** Start the 5-minute scheduler loop (idempotent). Call once on app ready. */
export function startScheduler(): void {
  if (timer) return
  timer = setInterval(() => void tick(), 5 * 60 * 1000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
