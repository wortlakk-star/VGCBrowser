// ── VGC Browser — lightweight session-debug file logger ──────────────────────
// Electron GUI processes don't emit console output to an inheritable stderr, so to
// diagnose the session/cookie flow we append to a plain file in userData.
//
// Electron is required LAZILY (and guarded): modules that log — password-bridge, cloud-data,
// profile-lock — are also bundled into the plain-node verify scripts (test/verify-*.ts), where
// `require('electron')` throws. Outside Electron the log goes to VGC_SESS_LOG if set, else
// nowhere.
import { appendFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'

// Cap the session log so it can't grow unbounded. When it passes ~1 MB we rotate to
// a single .1 backup (overwritten each time) → at most ~2 MB on disk, ever.
const MAX_BYTES = 1_000_000

let resolvedPath: string | null | undefined

function logPath(): string | null {
  if (resolvedPath !== undefined) return resolvedPath
  resolvedPath = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    if (electron?.app?.getPath) resolvedPath = join(electron.app.getPath('userData'), 'vgc-sess.log')
  } catch {
    /* not running inside Electron (verify scripts) */
  }
  if (!resolvedPath && process.env.VGC_SESS_LOG) resolvedPath = process.env.VGC_SESS_LOG
  return resolvedPath
}

export function dbg(msg: string): void {
  try {
    const path = logPath()
    if (!path) return
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
