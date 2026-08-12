// Remove macOS resource-fork sidecars before electron-builder signs the bundle.
// Unexpected `._*` files inside nested frameworks invalidate strict verification.
const { readdir, rm } = require('fs/promises')
const { join } = require('path')

async function clean(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async (entry) => {
      const full = join(root, entry.name)
      if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
        await rm(full, { recursive: true, force: true })
      } else if (entry.isDirectory()) {
        await clean(full)
      }
    })
  )
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  await clean(context.appOutDir)
}
