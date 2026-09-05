// Graceful-stop verification (session flush on kick / Stop / quit).
//
// Chromium's cookie store is write-behind (commits every ~30 s or on a CLEAN shutdown). The
// app stops the engine when another machine takes the profile over, when the user presses
// Stop, and on quit — if that stop is a forced termination, whatever the user did in the last
// ~30 s (typically the login that matters most) never reaches disk, so it never reaches the
// cloud or the other machine. This test launches a real engine, sets a cookie, stops it 2 s
// later the way profile-manager.ts now does (Windows: `taskkill /PID` = WM_CLOSE; POSIX:
// SIGTERM), and asserts the cookie is on disk. With --forced it does the old proc.kill()
// instead and expects the cookie to be MISSING on Windows (documents the bug it fixes).
//
// Run: npm run verify:stop -- [/optional/path/to/engine] [--forced]
// On Windows it falls back to Google Chrome when no VGC Core is installed. Headful — the
// engine window is visible for ~3 s.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from '../src/main/cdp'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const argv = process.argv.slice(2)
const FORCED = argv.includes('--forced')
const engineArg = argv.find((a) => !a.startsWith('--'))

function defaultEngine(): string {
  if (process.platform === 'darwin') {
    const installed = join(
      process.env.HOME ?? '',
      'Library/Application Support/vgc-browser/engine/VGC Core.app/Contents/MacOS/Chromium'
    )
    if (existsSync(installed)) return installed
    return resolve(process.cwd(), '../vgc-chromium/src/out/vgc/Chromium.app/Contents/MacOS/Chromium')
  }
  if (process.platform === 'win32') {
    const installed = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'vgc-browser', 'engine', 'chromium', 'chrome.exe')
      : ''
    if (installed && existsSync(installed)) return installed
    for (const chrome of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ]) {
      if (existsSync(chrome)) {
        console.log('[stop] no VGC Core installed — falling back to Google Chrome:', chrome)
        return chrome
      }
    }
    return installed || 'D:\\chromium\\src\\out\\vgc\\chrome.exe'
  }
  return resolve(process.cwd(), '../vgc-chromium/src/out/vgc/chrome')
}

const ENGINE = engineArg || process.env.VGC_ENGINE_PATH || defaultEngine()

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`)
}

/** Mirrors requestEngineExit() in src/main/profile-manager.ts. */
function requestGracefulExit(proc: ChildProcess): string {
  if (process.platform === 'win32' && proc.pid) {
    return execFileSync('taskkill', ['/PID', String(proc.pid)], { encoding: 'utf8', windowsHide: true }).trim()
  }
  proc.kill()
  return 'SIGTERM sent'
}

async function cookiesOnDisk(userDataDir: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const file = join(userDataDir, 'Default', 'Network', 'Cookies')
  const db = new SQL.Database(readFileSync(file))
  const res = db.exec('SELECT host_key, name FROM cookies')
  db.close()
  return res.length ? (res[0].values as unknown[][]).map((r) => `${r[0]}|${r[1]}`) : []
}

async function main(): Promise<void> {
  console.log('[stop] engine:', ENGINE, FORCED ? '(FORCED kill — expecting data loss on Windows)' : '(graceful)')
  assert(existsSync(ENGINE), `engine not found: ${ENGINE}`)
  const dir = mkdtempSync(join(tmpdir(), 'vgc-stop-'))
  const args = [
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--proxy-server=http://127.0.0.1:9',
    '--window-size=640,480',
    '--remote-debugging-pipe',
    'about:blank'
  ]
  const proc = spawn(ENGINE, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>((done) => proc.once('exit', (code) => done(code)))
  const conn = CdpConnection.connectPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable)
  try {
    const v = (await conn.send('Browser.getVersion')) as { product?: string }
    console.log('[stop] engine up:', v.product, 'pid', proc.pid)
    await sleep(1500) // let the window appear (WM_CLOSE needs a window)
    await conn.send('Storage.setCookies', {
      cookies: [
        {
          name: 'fresh_login',
          value: 'just-logged-in',
          domain: '.example.com',
          path: '/',
          secure: true,
          expires: Math.floor(Date.now() / 1000) + 86_400
        }
      ]
    })
    console.log('[stop] cookie set — stopping the engine 2 s later (inside the ~30 s commit window)…')
    await sleep(2000)
    conn.close()
    const t0 = Date.now()
    if (FORCED) {
      proc.kill()
      console.log('[stop] proc.kill() sent')
    } else {
      console.log('[stop]', requestGracefulExit(proc))
    }
    const code = await Promise.race([exited, sleep(15_000).then(() => 'TIMEOUT' as const)])
    console.log(`[stop] exit=${String(code)} after ${Date.now() - t0}ms`)
    if (code === 'TIMEOUT') {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* gone */
      }
    }
    assert(code !== 'TIMEOUT', 'engine must exit within 15 s of the stop request')
    await sleep(1000)
    const ck = join(dir, 'Default', 'Network', 'Cookies')
    for (const suffix of ['', '-journal', '-wal']) {
      let size = 'missing'
      try {
        size = `${statSync(ck + suffix).size} bytes`
      } catch {
        /* missing */
      }
      console.log(`      Cookies${suffix}: ${size}`)
    }
    const rows = await cookiesOnDisk(dir)
    const present = rows.includes('.example.com|fresh_login')
    console.log(`      cookies on disk: ${JSON.stringify(rows)}`)
    if (FORCED) {
      console.log(
        present
          ? '\nNOTE: the cookie survived a forced kill on this platform/engine (flush happened to land).'
          : '\nCONFIRMED: a forced kill loses a cookie set 2 s earlier — this is the bug the graceful stop fixes.'
      )
    } else {
      assert(present, 'cookie set 2 s before a graceful stop must be on disk')
      console.log('\nPASS: graceful stop flushed the cookie to disk ✓')
    }
  } finally {
    try {
      conn.close()
    } catch {
      /* closed */
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
