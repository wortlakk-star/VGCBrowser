// Dựng bundle passkeys + passkey-ext với phần giả (electron / guard / khoá tài khoản) cho passkey-e2e.mjs.
import { build } from 'esbuild'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

const here = import.meta.dirname
writeFileSync(resolve(here, 'stub-electron.cjs'), "module.exports = { app: { getPath: () => process.env.PK_UD } }\n")
writeFileSync(resolve(here, 'stub-guard.cjs'), `module.exports = {
  getRelockMinutes: async () => 0,
  isLocked: async () => false,
  unlock: async () => ({ ok: false, action: 'wrong' })
}\n`)
writeFileSync(resolve(here, 'stub-secret.cjs'), `const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto')
const SECRET = process.env.PK_SECRET || 'ab'.repeat(32)
const MAGIC = Buffer.from('VGCENC1\\0', 'latin1')
const keyFor = (secret, ctx) => createHash('sha256').update(secret + ':' + ctx).digest()
module.exports = {
  getAccountSecret: async () => (process.env.PK_NOSECRET ? null : SECRET),
  isEncryptedBytes: (b) => b.length >= MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC),
  encryptBytes: (secret, ctx, data) => {
    const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', keyFor(secret, ctx), iv)
    const enc = Buffer.concat([c.update(data), c.final()]); return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc])
  },
  decryptBytes: (secret, ctx, buf) => {
    try { const body = buf.subarray(MAGIC.length); const d = createDecipheriv('aes-256-gcm', keyFor(secret, ctx), body.subarray(0, 12))
      d.setAuthTag(body.subarray(12, 28)); return Buffer.concat([d.update(body.subarray(28)), d.final()]) } catch { return null }
  }
}\n`)
writeFileSync(resolve(here, 'entry.ts'), `export { ensurePasskeyExtension } from '../../src/main/passkey-ext'
export { listPasskeys, deletePasskey } from '../../src/main/passkeys'\n`)

const stubs = {
  electron: resolve(here, 'stub-electron.cjs'),
  './guard': resolve(here, 'stub-guard.cjs'),
  './account-secret': resolve(here, 'stub-secret.cjs')
}
await build({
  entryPoints: [resolve(here, 'entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: resolve(here, 'bundle.cjs'),
  logLevel: 'warning',
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^(electron|\.\/guard|\.\/account-secret)$/ }, (a) => ({ path: stubs[a.path] }))
    }
  }]
})
console.log('bundle ok')
