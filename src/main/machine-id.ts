// ── VGC Browser — stable per-machine ID ──────────────────────────────────────
// A random UUID generated once and persisted in userData, so the admin panel (/quanly)
// can see WHICH machine an account signs in from — and how many machines share one
// license. Deliberately NOT hardware-derived: a hardware fingerprint is brittle across
// OS reinstalls and reads as spyware; a stable random id that survives app restarts is
// all the admin needs to tell machines apart.

import { app } from 'electron'
import { hostname } from 'os'
import { join } from 'path'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { randomUUID } from 'crypto'
import { isUuid } from './validation'

let cached = ''

function idFile(): string {
  return join(app.getPath('userData'), 'vgc-machine-id')
}

function readPersistedId(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 128) return null
    const value = readFileSync(fd, 'utf8').trim()
    return isUuid(value) ? value : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function persistId(file: string, id: string): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(
      temp,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600
    )
    writeFileSync(fd, id, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, file)
  } finally {
    if (fd !== null) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      // The successful rename already consumed the temporary file.
    }
  }
}

/** A stable id for this machine (persisted in userData). Falls back to an ephemeral id
 *  if the file can't be read/written, so the report still carries *something*. */
export function getMachineId(): string {
  if (cached) return cached
  try {
    const f = idFile()
    const persisted = readPersistedId(f)
    if (persisted) return (cached = persisted)
    const id = randomUUID()
    persistId(f, id)
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
