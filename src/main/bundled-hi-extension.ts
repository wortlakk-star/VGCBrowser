// ── VGC Browser — bundled HI extension integrity ─────────────────────────────
// HI handles cookie transfers, so treat its unpacked resources as executable code.
// The app validates the shipped files before every profile launch to catch a modified
// loose resource directory before Chromium loads it.

import { createHash } from 'crypto'
import { lstatSync, readFileSync } from 'fs'
import { join } from 'path'

const HI_FILES: Readonly<Record<string, string>> = {
  'manifest.json': '0179b32fd4a4ec6d0ceb14e8f6acf1fa0d54d63e2fc51d08902d9e63d66b92a1',
  'popup.css': '42e9ecf2909314790ddb6a23186d02319937278e1605a35d4ab86e190c3314bf',
  'popup.html': '1a5c1f060d27758e79787f5df1c9bc544b0a0382c8860ca0ae9586449ee15a54',
  'popup.js': 'fd3e8fad4c080018812eb9237ba92bd02910d7b1d6e986526e5672726decde49'
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

/**
 * Return the HI unpacked-extension directory after verifying its exact shipped
 * contents. This keeps a modified loose resource from reading cookies in profiles.
 */
export function validateBundledHiExtension(dir: string): string {
  const dirStat = lstatSync(dir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error('Extension HI nội bộ không phải thư mục an toàn.')
  }

  let manifestText = ''
  for (const [name, expectedHash] of Object.entries(HI_FILES)) {
    const file = join(dir, name)
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 512 * 1024) {
      throw new Error(`File extension HI không an toàn: ${name}`)
    }
    const contents = readFileSync(file)
    if (sha256(contents) !== expectedHash) {
      throw new Error(`Extension HI đã bị thay đổi: ${name}`)
    }
    if (name === 'manifest.json') manifestText = contents.toString('utf8')
  }

  try {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>
    if (
      manifest.manifest_version !== 3 ||
      manifest.name !== 'HI' ||
      manifest.version !== '1.3.3' ||
      !manifest.action ||
      manifest.background ||
      manifest.content_scripts
    ) {
      throw new Error('manifest không đúng bản đã duyệt')
    }
  } catch (error) {
    throw new Error(
      `Manifest extension HI không hợp lệ: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return dir
}
