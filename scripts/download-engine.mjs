// ── VGC Browser — temporary engine downloader ────────────────────────────────
// Downloads the latest ungoogled-chromium Windows x64 build into engine/chromium
// to act as the temporary engine until our patched "VGC Core" build (Phase 5) is
// ready. Run with:  npm run download-engine
//
// Notes:
//   • ungoogled-chromium ships a stock-ish Chromium; it is NOT yet our antidetect
//     engine. It only lets the launch loop work end-to-end now.
//   • Requires network access. Large download (~150 MB).

import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const engineDir = join(root, 'engine')
const zipPath = join(engineDir, 'ungoogled-chromium.zip')
const outDir = join(engineDir, 'chromium')

const RELEASES_API =
  'https://api.github.com/repos/ungoogled-software/ungoogled-chromium-windows/releases'

async function main() {
  mkdirSync(engineDir, { recursive: true })

  console.log('→ Querying latest ungoogled-chromium release…')
  const res = await fetch(RELEASES_API, {
    headers: { 'User-Agent': 'vgc-browser', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const releases = await res.json()

  // Find the newest release that has a windows x64 .zip (not the installer).
  let asset = null
  for (const rel of releases) {
    asset = (rel.assets ?? []).find(
      (a) => /windows[._-]x64\.zip$/i.test(a.name) && !/installer/i.test(a.name)
    )
    if (asset) {
      console.log(`→ Release ${rel.tag_name}: ${asset.name}`)
      break
    }
  }
  if (!asset) throw new Error('No windows_x64 .zip asset found in recent releases.')

  console.log(`→ Downloading (${(asset.size / 1e6).toFixed(1)} MB)…`)
  const dl = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'vgc-browser' }
  })
  if (!dl.ok || !dl.body) throw new Error(`Download failed: ${dl.status}`)
  await pipeline(Readable.fromWeb(dl.body), createWriteStream(zipPath))
  console.log('→ Downloaded:', zipPath)

  // Extract with PowerShell (Windows-first).
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  console.log('→ Extracting…')
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`],
    { stdio: 'inherit' }
  )

  // ungoogled-chromium zips contain a versioned subfolder; flatten if chrome.exe
  // is one level down.
  console.log('\n✓ Done. Engine extracted under engine/chromium')
  console.log('  If chrome.exe is inside a subfolder, the launcher still finds it via VGC_ENGINE_PATH.')
  console.log('  Tip: set VGC_ENGINE_PATH to the exact chrome.exe to be explicit.')
}

main().catch((err) => {
  console.error('✗', err.message)
  process.exit(1)
})
