// ── VGC Browser — lightweight session-debug file logger ──────────────────────
// Electron GUI processes don't emit console output to an inheritable stderr, so to
// diagnose the session/cookie flow we append to a plain file in userData.
import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export function dbg(msg: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'vgc-sess.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* best-effort */
  }
}
