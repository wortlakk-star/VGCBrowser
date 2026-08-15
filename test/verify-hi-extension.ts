import assert from 'assert'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { validateBundledHiExtension } from '../src/main/bundled-hi-extension'

const extensionDir = resolve(process.cwd(), 'resources/extensions/HI')
const files = ['manifest.json', 'popup.css', 'popup.html', 'popup.js']
const tempRoot = mkdtempSync(join(tmpdir(), 'vgc-hi-extension-'))

try {
  assert.equal(validateBundledHiExtension(extensionDir), extensionDir)

  const lfDir = join(tempRoot, 'lf')
  cpSync(extensionDir, lfDir, { recursive: true })
  for (const name of files) {
    const file = join(lfDir, name)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
  }
  assert.equal(validateBundledHiExtension(lfDir), lfDir)

  const crlfDir = join(tempRoot, 'crlf')
  cpSync(lfDir, crlfDir, { recursive: true })
  for (const name of files) {
    const file = join(crlfDir, name)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'), 'utf8')
  }
  assert.equal(validateBundledHiExtension(crlfDir), crlfDir)

  for (const [index, name] of files.entries()) {
    const tamperedDir = join(tempRoot, `tampered-${index}`)
    cpSync(crlfDir, tamperedDir, { recursive: true })
    const file = join(tamperedDir, name)
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')]))
    assert.throws(
      () => validateBundledHiExtension(tamperedDir),
      (error) => error instanceof Error && error.message === `Extension HI đã bị thay đổi: ${name}`
    )
  }

  console.log('PASS: bundled HI v1.3.3 verifies LF/CRLF and rejects tampering in every file')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
