// ── VGC Browser — stable per-machine ID ──────────────────────────────────────
// A random UUID generated once and persisted in userData, so the admin panel (/quanly)
// can see WHICH machine an account signs in from — and how many machines share one
// license. Deliberately NOT hardware-derived: a hardware fingerprint is brittle across
// OS reinstalls and reads as spyware; a stable random id that survives app restarts is
// all the admin needs to tell machines apart.

import { app } from 'electron'
import { hostname } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'

let cached = ''

function idFile(): string {
  return join(app.getPath('userData'), 'vgc-machine-id')
}

/** A stable id for this machine (persisted in userData). Falls back to an ephemeral id
 *  if the file can't be read/written, so the report still carries *something*. */
export function getMachineId(): string {
  if (cached) return cached
  try {
    const f = idFile()
    if (existsSync(f)) {
      const v = readFileSync(f, 'utf-8').trim()
      if (v) return (cached = v)
    }
    const id = randomUUID()
    writeFileSync(f, id)
    return (cached = id)
  } catch {
    return (cached = cached || randomUUID())
  }
}

/** Human-readable machine name (OS hostname) so the admin recognises the device. */
export function getMachineName(): string {
  try {
    return hostname() || 'unknown'
  } catch {
    return 'unknown'
  }
}
