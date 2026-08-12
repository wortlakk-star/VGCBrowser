// ── VGC Browser — forced-update version gate ─────────────────────────────────
// Lets us CUT OFF old app versions remotely: the app fetches a tiny JSON on the
// server (min-version.json) at startup; if this build is older than minVersion, the
// UI blocks everything with a "must update" screen. To force everyone onto a new
// build, just bump minVersion in that one file (edit it over SSH) — no rebuild.
//
// Fail-OPEN on any error (network glitch, server down, bad JSON): a transient problem
// must never lock out an already-up-to-date user. The gate only ever blocks when it
// POSITIVELY confirms this build < minVersion.

import { app } from 'electron'
import { trustedExternalUrl } from './validation'
import { readLimitedResponseJson } from './http-limit'

export interface VersionGate {
  blocked: boolean
  current: string
  min: string
  downloadUrl: string
}

// Kept next to the update feed so one place (the /dl/ dir) controls distribution.
const MIN_VERSION_URL = 'https://vgcbrowser.com/dl/min-version.json'
const DEFAULT_DOWNLOAD = 'https://vgcbrowser.com/'

/** Compare dotted numeric versions. <0 if a<b, 0 if equal, >0 if a>b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export async function checkVersionGate(): Promise<VersionGate> {
  const current = app.getVersion()
  const open: VersionGate = { blocked: false, current, min: '', downloadUrl: DEFAULT_DOWNLOAD }
  // Never gate a dev run (there is no installed version to update).
  if (!app.isPackaged) return open
  try {
    const res = await fetch(`${MIN_VERSION_URL}?t=${Date.now()}`, {
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
      redirect: 'error'
    } as RequestInit)
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return open
    }
    const j = await readLimitedResponseJson<{ minVersion?: string; downloadUrl?: string }>(
      res,
      64 * 1024
    )
    const min = String(j.minVersion || '').trim()
    const downloadUrl =
      trustedExternalUrl(j.downloadUrl, new Set(['vgcbrowser.com', 'www.vgcbrowser.com'])) ??
      DEFAULT_DOWNLOAD
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(min)) return open
    return { blocked: cmpVersion(current, min) < 0, current, min, downloadUrl }
  } catch {
    return open // fail-open
  }
}
