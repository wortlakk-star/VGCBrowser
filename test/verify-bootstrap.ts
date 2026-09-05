// First-open bootstrap verification (cross-machine session sync).
//
// Proves, against a REAL engine binary, the mechanism profile-manager.ts relies on when a
// profile is opened for the first time on a machine:
//   1. a fresh user-data-dir has NO credential stores → credentialStoresReady() is false;
//   2. one headless, network-less engine run (same switches as bootstrapProfileStores) creates
//      `Local State` (os_crypt key), `Default/Network/Cookies` and `Default/Login Data`, and a
//      graceful Browser.close leaves no pending SQLite journal;
//   3. the bridge can now MERGE a "cloud" cookie + saved login into those stores
//      (importCookies / importLogins) and read them back decrypted (exportCookies / exportLogins);
//   4. the ENGINE itself can read the merged cookie (Storage.getCookies on a second headless
//      run) — i.e. the bridge sealed it with the exact per-machine key the engine uses.
//
// Run: npm run verify:bootstrap -- /optional/path/to/engine
// Without an argument it uses the installed VGC Core engine; on Windows it falls back to
// Google Chrome (same Chromium os_crypt code path) when no VGC Core is installed.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from '../src/main/cdp'
import {
  credentialStoresReady,
  exportCookies,
  exportLogins,
  importCookies,
  importLogins,
  resetEngineKeyCache
} from '../src/main/password-bridge'
import type { SavedCookie, SavedLogin } from '../src/shared/types'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

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
        console.log('[bootstrap] no VGC Core installed — falling back to Google Chrome:', chrome)
        return chrome
      }
    }
    return installed || 'D:\\chromium\\src\\out\\vgc\\chrome.exe'
  }
  return resolve(process.cwd(), '../vgc-chromium/src/out/vgc/chrome')
}

const ENGINE = process.argv[2] || process.env.VGC_ENGINE_PATH || defaultEngine()

// Keep in sync with bootstrapProfileStores() in src/main/profile-manager.ts.
function bootstrapArgs(userDataDir: string): string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--proxy-server=http://127.0.0.1:9',
    '--remote-debugging-pipe',
    'about:blank'
  ]
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`)
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/** Spawn the engine headless over the CDP pipe, run `fn`, then close it gracefully. */
async function headlessRun(
  userDataDir: string,
  fn: (conn: CdpConnection) => Promise<void>
): Promise<{ graceful: boolean; ms: number }> {
  const t0 = Date.now()
  const proc: ChildProcess = spawn(ENGINE, bootstrapArgs(userDataDir), {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
  })
  const exited = new Promise<void>((done) => proc.once('exit', () => done()))
  const conn = CdpConnection.connectPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable)
  try {
    await fn(conn)
    await Promise.race([conn.send('Browser.close').catch(() => undefined), sleep(5000)])
  } finally {
    conn.close()
  }
  const graceful = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)])
  if (!graceful) {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* gone */
    }
    await Promise.race([exited, sleep(3000)])
  }
  return { graceful, ms: Date.now() - t0 }
}

/** Chrome epoch: microseconds since 1601-01-01. */
function chromeNowUs(offsetSec = 0): number {
  return Math.round((Date.now() / 1000 + offsetSec + 11_644_473_600) * 1_000_000)
}

async function main(): Promise<void> {
  console.log('[bootstrap] engine:', ENGINE)
  assert(existsSync(ENGINE), `engine not found: ${ENGINE}`)
  const dir = mkdtempSync(join(tmpdir(), 'vgc-bootstrap-'))
  const id = 'verify-bootstrap'
  console.log('[bootstrap] user-data-dir:', dir)
  const cookiesDb = join(dir, 'Default', 'Network', 'Cookies')
  const loginDb = join(dir, 'Default', 'Login Data')
  const localState = join(dir, 'Local State')

  try {
    // 1. Fresh dir → the bridge has nothing to merge into.
    assert(!(await credentialStoresReady(dir)), 'fresh dir must NOT be ready')
    console.log('[1/4] fresh dir: credentialStoresReady=false ✓')

    // 2. Bootstrap run (what profile-manager does on the first open on a machine).
    const boot = await headlessRun(dir, async (conn) => {
      await conn.send('Storage.setCookies', {
        cookies: [
          {
            name: 'vgc_bootstrap',
            value: '1',
            domain: 'vgc-bootstrap.invalid',
            path: '/',
            httpOnly: true,
            expires: Math.floor(Date.now() / 1000) + 120
          }
        ]
      })
    })
    console.log(`[2/4] bootstrap run: graceful=${boot.graceful} in ${boot.ms}ms`)
    assert(boot.graceful, 'engine must exit gracefully after Browser.close')
    for (const f of [localState, cookiesDb, loginDb]) {
      console.log(`      ${f.slice(dir.length + 1)}: ${fileSize(f)} bytes`)
      assert(fileSize(f) > 0, `${f} must exist after bootstrap`)
    }
    for (const j of [cookiesDb + '-journal', cookiesDb + '-wal', loginDb + '-journal', loginDb + '-wal']) {
      assert(fileSize(j) <= 0, `${j} must be empty/absent after a graceful close (got ${fileSize(j)})`)
    }
    if (process.platform === 'win32') {
      const ls = JSON.parse(readFileSync(localState, 'utf8')) as {
        os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string }
      }
      assert(ls.os_crypt?.encrypted_key, 'Local State must carry os_crypt.encrypted_key')
      console.log(
        `      os_crypt.encrypted_key present (${ls.os_crypt!.encrypted_key!.length} chars)` +
          (ls.os_crypt?.app_bound_encrypted_key ? ' — NOTE: app-bound key also present' : '')
      )
    }
    for (const t of ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
      rmSync(join(dir, 'Default', t), { recursive: true, force: true })
    }
    resetEngineKeyCache(dir)
    assert(await credentialStoresReady(dir), 'dir must be ready after bootstrap')
    console.log('      credentialStoresReady=true ✓')

    // 3. Merge a "cloud" cookie + saved login (what downloadCredentials does), read back.
    const now = chromeNowUs()
    const cookie: SavedCookie = {
      value: 'cloud-session-value-8f3a2c',
      cols: {
        creation_utc: now,
        host_key: '.example.com',
        top_frame_site_key: '',
        has_cross_site_ancestor: 0,
        name: 'vgc_session',
        path: '/',
        expires_utc: chromeNowUs(86_400),
        is_secure: 1,
        is_httponly: 1,
        last_access_utc: now,
        has_expires: 1,
        is_persistent: 1,
        priority: 1,
        samesite: -1,
        source_scheme: 2,
        source_port: 443,
        last_update_utc: now,
        source_type: 0
      }
    }
    const login: SavedLogin = {
      origin_url: 'https://example.com/login',
      signon_realm: 'https://example.com/',
      password: 'Cl0ud-P@ssw0rd',
      action_url: 'https://example.com/login',
      username_element: 'user',
      username_value: 'alice@example.com',
      password_element: 'pass',
      scheme: 0,
      date_created: now,
      date_password_modified: now,
      times_used: 1,
      blacklisted_by_user: 0
    }
    const nc = await importCookies(dir, id, [cookie])
    const nl = await importLogins(dir, id, [login])
    console.log(`[3/4] import: cookies=${nc} logins=${nl}`)
    assert(nc === 1, 'importCookies must merge 1 cookie')
    assert(nl === 1, 'importLogins must merge 1 login')
    const backCookies = await exportCookies(dir, id)
    const backLogins = await exportLogins(dir, id)
    const found = backCookies.find((c) => c.cols.name === 'vgc_session' && c.cols.host_key === '.example.com')
    assert(found && found.value === cookie.value, 'exported cookie must decrypt to the imported value')
    const foundLogin = backLogins.find((l) => l.signon_realm === login.signon_realm)
    assert(foundLogin && foundLogin.password === login.password, 'exported login must decrypt to the imported password')
    console.log('      bridge round-trip (decrypt with the machine key) ✓')

    // 4. The ENGINE must be able to read the merged cookie with its own key.
    let engineSaw: { name: string; value: string; domain: string }[] = []
    const run2 = await headlessRun(dir, async (conn) => {
      const r = (await conn.send('Storage.getCookies')) as {
        cookies: { name: string; value: string; domain: string }[]
      }
      engineSaw = r.cookies
    })
    const seen = engineSaw.find((c) => c.name === 'vgc_session' && c.domain === '.example.com')
    console.log(
      `[4/4] engine relaunch (${run2.ms}ms): sees ${engineSaw.length} cookie(s)` +
        (seen ? ` — vgc_session="${seen.value}"` : ' — vgc_session MISSING')
    )
    assert(seen, 'engine must load the bridge-imported cookie')
    assert(seen!.value === cookie.value, 'engine must decrypt the bridge-imported cookie to the same value')
    console.log('\nPASS: first-open bootstrap → credential merge → engine reads the session ✓')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
