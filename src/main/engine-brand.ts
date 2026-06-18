// ── VGC Browser — macOS engine branding ──────────────────────────────────────
// The Mac engine is the system Google Chrome, so a profile's browser shows the
// Chrome icon on the Dock. To show the VGC logo instead we keep a VGC-branded
// CLONE of Chrome.app and launch profiles from it:
//
//   • Clone via APFS clonefile (cp -Rc) — instant and shares disk blocks, so the
//     1.3GB Chrome costs ~no extra space until files diverge.
//   • Swap only Contents/Resources/app.icns for the VGC icon. This invalidates the
//     code-signature SEAL but NOT the main executable's signature, so (for a local,
//     non-quarantined copy) Chrome still launches — verified.
//   • Keep CFBundleIdentifier = com.google.Chrome so the os_crypt keychain key
//     ("Chrome Safe Storage") stays the same → cookies/passwords still decrypt.
//   • Re-clone when the system Chrome version changes (clonefile makes this cheap).
//
// Windows uses rcedit on the bundled chrome.exe instead (see scripts/brand-engine.mjs).
// Returns the branded binary path, or null on non-mac / no Chrome / any failure,
// in which case the caller falls back to the system Chrome.

import { app } from 'electron'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { execFileSync } from 'child_process'

function plistValue(plist: string, key: string): string {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
      encoding: 'utf-8'
    }).trim()
  } catch {
    return ''
  }
}

export function brandedMacEngine(systemChromeBinary: string): string | null {
  if (process.platform !== 'darwin') return null

  // /Applications/Google Chrome.app/Contents/MacOS/Google Chrome → the .app root.
  const srcApp = systemChromeBinary.replace(/\/Contents\/MacOS\/[^/]+$/, '')
  if (!srcApp.endsWith('.app') || !existsSync(srcApp)) return null

  // The VGC icon shipped in the packaged app (electron-builder writes icon.icns).
  const icns = join(process.resourcesPath, 'icon.icns')
  if (!existsSync(icns)) return null // dev build / no packaged icon → skip branding

  const brandedApp = join(app.getPath('userData'), 'engine', 'VGC Browser.app')
  const brandedBin = join(brandedApp, 'Contents', 'MacOS', 'Google Chrome')

  const srcVer = plistValue(join(srcApp, 'Contents', 'Info.plist'), 'CFBundleShortVersionString')
  const dstVer = existsSync(brandedApp)
    ? plistValue(join(brandedApp, 'Contents', 'Info.plist'), 'CFBundleShortVersionString')
    : ''

  try {
    if (!existsSync(brandedBin) || (srcVer && srcVer !== dstVer)) {
      execFileSync('/bin/rm', ['-rf', brandedApp])
      execFileSync('/bin/mkdir', ['-p', dirname(brandedApp)])
      // APFS clonefile — instant, copy-on-write (no real extra disk).
      execFileSync('/bin/cp', ['-Rc', srcApp, brandedApp])
      // Swap the Dock icon to the VGC logo.
      execFileSync('/bin/cp', [icns, join(brandedApp, 'Contents', 'Resources', 'app.icns')])
    }
    return existsSync(brandedBin) ? brandedBin : null
  } catch {
    return null
  }
}
