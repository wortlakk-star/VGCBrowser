// ── VGC Browser — API lifecycle manager ──────────────────────────────────────
// Wires the electron-free api-server to the real profile manager + settings, and
// owns the singleton handle so it can be (re)started when settings change.

import { startApiServer, type ApiHandle } from './api-server'
import { getSettings } from './settings'
import { getBrowserWsUrl } from './cdp'
import { listProfiles, deleteProfile } from './store'
import { launchProfile, stopProfile, getRuntimeState } from './profile-manager'
import { createProfile, updateProfile } from './profiles-service'

let handle: ApiHandle | null = null

export async function restartApiServer(): Promise<{ running: boolean; port?: number; error?: string }> {
  stopApiServer()
  const s = await getSettings()
  if (!s.apiEnabled) return { running: false }
  try {
    handle = await startApiServer({
      port: s.apiPort,
      token: s.apiToken,
      deps: {
        listProfiles,
        launchProfile,
        stopProfile,
        getRuntimeState,
        browserWsForPort: (p) => getBrowserWsUrl(p),
        createProfile,
        updateProfile,
        deleteProfile
      }
    })
    return { running: true, port: handle.port }
  } catch (e) {
    return { running: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function stopApiServer(): void {
  if (handle) {
    handle.close()
    handle = null
  }
}
