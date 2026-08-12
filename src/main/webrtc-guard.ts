// ── VGC Browser — per-profile privacy/fingerprint guard ───────────────────────
// The guard is loaded in every mode. Its service worker applies Chrome's native WebRTC
// privacy policy and blocks geolocation permission. Fingerprint surfaces are handled only
// by the dedicated VGC Core engine; injecting page JavaScript here would create a second,
// observable layer and can make worker/iframe values disagree with the main document.

import { writeFileSync, mkdirSync, renameSync, rmSync, lstatSync, chmodSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { Fingerprint } from '../shared/types'

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'VGC',
  version: '1.0',
  permissions: ['privacy', 'contentSettings'],
  background: { service_worker: 'background.js' }
})

function writeGuardFile(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * Write the per-profile guard extension into the profile's user-data-dir and return its
 * directory (to pass to --load-extension). It applies native WebRTC privacy settings and
 * denies geolocation to avoid leaking the host's real location.
 * It lives OUTSIDE Default/ so the cloud sync (which only zips Default/) never carries this
 * machine's proxy IP elsewhere.
 */
export function ensureNativeGuardExtension(userDataDir: string, fp: Fingerprint): string {
  const dir = join(userDataDir, 'vgc-webrtc-guard')
  try {
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const dirStat = lstatSync(dir)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw new Error('Guard extension path is not a private directory')
    }
    chmodSync(dir, 0o700)
    writeGuardFile(join(dir, 'manifest.json'), MANIFEST)
    const rtcPolicy = fp.webrtc === 'real' ? 'default_public_interface_only' : 'disable_non_proxied_udp'
    writeGuardFile(
      join(dir, 'background.js'),
      `const apply=()=>{try{chrome.privacy.network.webRTCIPHandlingPolicy.set({value:${JSON.stringify(rtcPolicy)},scope:'regular'});chrome.privacy.network.webRTCMultipleRoutesEnabled?.set({value:false,scope:'regular'});chrome.privacy.network.webRTCNonProxiedUdpEnabled?.set({value:${fp.webrtc === 'real'},scope:'regular'});chrome.contentSettings.location.set({primaryPattern:'<all_urls>',setting:'block',scope:'regular'});}catch(e){}};apply();chrome.runtime.onStartup.addListener(apply);chrome.runtime.onInstalled.addListener(apply);`
    )
    // Remove the page-injected guard left by older releases. It is no longer referenced
    // by the manifest, but deleting it also prevents accidental reuse during development.
    rmSync(join(dir, 'guard.js'), { force: true })
    return dir
  } catch (error) {
    throw new Error(
      `Không thể tạo privacy guard: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
