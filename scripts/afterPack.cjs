// electron-builder afterPack hook — ad-hoc code-sign the macOS app.
//
// We don't have an Apple Developer certificate (paid), so the app can't be
// notarized. An UNSIGNED app, once downloaded (quarantined), is blocked by
// Gatekeeper as "VGC Browser is damaged and can't be opened" — a dead end for
// normal users. An AD-HOC signature (free, no cert) makes the signature valid, so
// the block downgrades to "unidentified developer", which users CAN bypass via
// right-click → Open, or System Settings → Privacy & Security → Open Anyway.
//
// Runs on macOS builds only; no-op elsewhere.
const { execSync } = require('child_process')
const { join } = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  console.log('  • ad-hoc signing (no Apple cert):', appPath)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
}
