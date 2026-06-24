// Diagnostic: launch the VGC engine exactly like production (same flags + real
// cdp-injector), open a bot-detection page, screenshot it so we can SEE what is
// still detectable (webdriver / CDP / headless / chrome object / etc).
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection, getBrowserWsUrl } from '../src/main/cdp'
import { attachInjector } from '../src/main/cdp-injector'
import { generateFingerprint } from '../src/shared/fingerprint'
import type { Profile } from '../src/shared/types'

const ENGINE = 'C:\\VGCBrowser\\engine\\chromium\\chrome.exe'
const PORT = 9455
const OUT = process.argv[2] || 'sannysoft.png'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const fp = generateFingerprint('windows')
  const profile = {
    id: 'diag-profile',
    name: 'diag',
    fingerprint: fp,
    cookies: [],
    proxy: { type: 'none' },
    extensions: []
  } as unknown as Profile

  const userDataDir = mkdtempSync(join(tmpdir(), 'vgc-diag-'))
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    `--lang=${fp.language}`,
    `--window-size=1280,1024`,
    `--user-agent=${fp.userAgent}`,
    'about:blank'
  ]
  console.log('launching engine:', ENGINE)
  const proc = spawn(ENGINE, args, { detached: false })
  await sleep(3500)

  const handle = await attachInjector(profile, PORT, { nativeWebgl: true })
  await handle.openUrl('https://bot.sannysoft.com')
  await sleep(9000)

  // Separate read-only connection just for screenshot + DOM read (Page/DOM domains
  // only — NOT Runtime — so we don't introduce the very leak we're testing).
  const conn = await CdpConnection.connect(await getBrowserWsUrl(PORT))
  const { targetInfos } = (await conn.send('Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>
  }
  const page = targetInfos.find((t) => t.type === 'page' && t.url.includes('sannysoft'))
  if (!page) {
    console.log('NO sannysoft page found; targets=', JSON.stringify(targetInfos))
    proc.kill()
    process.exit(1)
  }
  const { sessionId } = (await conn.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true
  })) as { sessionId: string }
  await conn.send('Page.enable', {}, sessionId)
  const shot = (await conn.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true },
    sessionId
  )) as { data: string }
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('screenshot saved to', OUT)

  proc.kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('DIAG ERROR:', e)
  process.exit(1)
})
