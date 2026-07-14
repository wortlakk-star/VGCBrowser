// ── VGC Browser — lightweight session-debug file logger ──────────────────────
// Electron GUI processes don't emit console output to an inheritable stderr, so to
// diagnose the session/cookie flow we append to a plain file in userData.
import { appendFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// Cap the session log so it can't grow unbounded. When it passes ~1 MB we rotate to
// a single .1 backup (overwritten each time) → at most ~2 MB on disk, ever.
const MAX_BYTES = 1_000_000

export function dbg(msg: string): void {
  try {
    const path = join(app.getPath('userData'), 'vgc-sess.log')
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, path + '.1')
    } catch {
      /* file missing or rename raced — fine, just append */
    }
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* best-effort */
  }
}
