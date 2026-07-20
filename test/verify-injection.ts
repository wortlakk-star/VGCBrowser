// ── VGC Browser — end-to-end injection verification ──────────────────────────
// Proves the antidetect core works against a REAL Chrome (headless): it uses the
// project's own CDP client + stealth-script generator to inject a fingerprint,
// then reads the values back from the page and asserts they were spoofed.
//
// Run (bundled):  npx esbuild test/verify-injection.ts --bundle --platform=node
//                   --format=esm --external:bufferutil --external:utf-8-validate
//                   --outfile=test/verify.mjs  &&  node test/verify.mjs

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection, getBrowserWsUrl } from '../src/main/cdp'
import { buildStealthScript, seedFromString } from '../src/main/fingerprint-script'
import { generateFingerprint } from '../src/shared/fingerprint'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9444

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function evaluate(
  conn: CdpConnection,
  sessionId: string,
  expression: string
): Promise<unknown> {
  const res = (await conn.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  )) as { result?: { value?: unknown } }
  return res.result?.value
}

async function main(): Promise<void> {
  // Fix known values so we can assert on them.
  const fp = generateFingerprint('windows')
  fp.hardwareConcurrency = 8
  fp.deviceMemory = 16
  fp.platform = 'Win32'
  fp.timezone = 'America/New_York'
  fp.webgl = {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'vgc-verify-'))
  const proc = spawn(CHROME, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    `--user-agent=${fp.userAgent}`,
    'about:blank'
  ])

  try {
    const wsUrl = await getBrowserWsUrl(PORT)
    const conn = await CdpConnection.connect(wsUrl)

    // New page we fully control.
    const created = (await conn.send('Target.createTarget', {
      url: 'about:blank'
    })) as { targetId: string }
    const attached = (await conn.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true
    })) as { sessionId: string }
    const sid = attached.sessionId

    await conn.send('Page.enable', {}, sid)
    await conn.send('Runtime.enable', {}, sid)
    await conn.send('Network.enable', {}, sid)

    // Native overrides (the real, undetectable part).
    await conn.send(
      'Network.setUserAgentOverride',
      {
        userAgent: fp.userAgent,
        acceptLanguage: fp.languages.join(','),
        platform: fp.platform,
        userAgentMetadata: {
          brands: [
            { brand: 'Not/A)Brand', version: '8' },
            { brand: 'Chromium', version: fp.uaFullVersion.split('.')[0] },
            { brand: 'Google Chrome', version: fp.uaFullVersion.split('.')[0] }
          ],
          platform: 'Windows',
          platformVersion: fp.uaPlatformVersion,
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
          fullVersion: fp.uaFullVersion
        }
      },
      sid
    )
    await conn.send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone }, sid)

    // JS stealth (our generator).
    const script = buildStealthScript(fp, seedFromString('test-profile-fixed-seed'))
    await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, sid)

    // Navigate to a secure (https) context so navigator.userAgentData exists.
    await conn.send('Page.navigate', { url: 'https://example.com' }, sid)
    await sleep(2500)

    // Read everything back.
    const cores = await evaluate(conn, sid, 'navigator.hardwareConcurrency')
    const mem = await evaluate(conn, sid, 'navigator.deviceMemory')
    const platform = await evaluate(conn, sid, 'navigator.platform')
    const webdriver = await evaluate(conn, sid, 'navigator.webdriver')
    const tz = await evaluate(
      conn,
      sid,
      'Intl.DateTimeFormat().resolvedOptions().timeZone'
    )
    const uaBrands = await evaluate(
      conn,
      sid,
      'JSON.stringify((navigator.userAgentData&&navigator.userAgentData.brands)||[])'
    )
    const gl = await evaluate(
      conn,
      sid,
      '(function(){try{var c=document.createElement("canvas");var g=c.getContext("webgl");return JSON.stringify({vendor:g.getParameter(37445),renderer:g.getParameter(37446)});}catch(e){return "ERR:"+e;}})()'
    )
    // ── Extra spoofs (client rects / screen avail / connection / mediaDevices) ──
    // clientRects: a plain 100×30 block has an EXACTLY-integer rect on clean Chrome;
    // our deterministic sub-pixel farbling makes width ≠ 100 by < 0.001, and two reads
    // must return the identical value (stable, not drifting).
    const rects = await evaluate(
      conn,
      sid,
      '(function(){try{var d=document.createElement("div");d.style.cssText="position:absolute;left:37px;top:59px;width:100px;height:30px";document.body.appendChild(d);var a=d.getBoundingClientRect();var b=d.getBoundingClientRect();var stable=(a.x===b.x&&a.width===b.width&&a.y===b.y);var noised=(a.width!==100&&Math.abs(a.width-100)<0.001);document.body.removeChild(d);return JSON.stringify({stable:stable,noised:noised,isRect:(a instanceof DOMRect)});}catch(e){return "ERR:"+e;}})()'
    )
    const availOff = await evaluate(conn, sid, 'screen.availLeft+","+screen.availTop')
    const netInfo = await evaluate(
      conn,
      sid,
      'navigator.connection?(navigator.connection.effectiveType+","+navigator.connection.downlink):"none"'
    )
    const mediaLabels = await evaluate(
      conn,
      sid,
      'navigator.mediaDevices&&navigator.mediaDevices.enumerateDevices?navigator.mediaDevices.enumerateDevices().then(function(l){return JSON.stringify({n:l.length,allBlank:l.every(function(d){return d.label==="";}),allReal:l.every(function(d){return d instanceof MediaDeviceInfo;})});}):"none"'
    )
    // getClientRects must stay a NATIVE DOMRectList (we farble only getBoundingClientRect).
    const gcrType = await evaluate(
      conn,
      sid,
      '(function(){try{return document.body.getClientRects() instanceof DOMRectList;}catch(e){return "ERR:"+e;}})()'
    )
    // Patched fns must carry the correct .name (empty .name + native toString is a tell).
    const nameOk = await evaluate(
      conn,
      sid,
      '(function(){try{return Element.prototype.getBoundingClientRect.name==="getBoundingClientRect"&&Object.getOwnPropertyDescriptor(Screen.prototype,"availLeft").get.name==="get availLeft";}catch(e){return "ERR:"+e;}})()'
    )

    const checks: Array<[string, unknown, unknown]> = [
      ['hardwareConcurrency', cores, fp.hardwareConcurrency],
      ['deviceMemory', mem, fp.deviceMemory],
      ['platform', platform, fp.platform],
      ['navigator.webdriver', webdriver, false],
      ['timezone', tz, fp.timezone]
    ]

    let pass = 0
    console.log('\n=== VGC injection verification ===')
    for (const [name, got, want] of checks) {
      const ok = got === want
      if (ok) pass++
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
    }

    // WebGL + UA brands (string contains checks).
    const glStr = String(gl)
    const glOk = glStr.includes('NVIDIA') && glStr.includes('RTX 3060')
    if (glOk) pass++
    console.log(`${glOk ? 'PASS' : 'FAIL'}  webgl: ${glStr}`)

    const brandsOk = String(uaBrands).includes('Google Chrome')
    if (brandsOk) pass++
    console.log(`${brandsOk ? 'PASS' : 'FAIL'}  userAgentData.brands: ${uaBrands}`)

    // clientRects farbling (stable + noised + real DOMRect).
    let rectsParsed: { stable?: boolean; noised?: boolean; isRect?: boolean } = {}
    try {
      rectsParsed = JSON.parse(String(rects))
    } catch {
      // leave empty → fails below
    }
    const rectsOk = rectsParsed.stable === true && rectsParsed.noised === true && rectsParsed.isRect === true
    if (rectsOk) pass++
    console.log(`${rectsOk ? 'PASS' : 'FAIL'}  clientRects: ${rects}`)

    // screen.availLeft / availTop forced to 0.
    const availOk = String(availOff) === '0,0'
    if (availOk) pass++
    console.log(`${availOk ? 'PASS' : 'FAIL'}  screen.avail offset: ${availOff}`)

    // navigator.connection normalised (effectiveType 4g, downlink capped at 10).
    const netOk = String(netInfo) === '4g,10'
    if (netOk) pass++
    console.log(`${netOk ? 'PASS' : 'FAIL'}  navigator.connection: ${netInfo}`)

    // mediaDevices labels stripped (no real hardware names leak).
    let mediaParsed: { n?: number; allBlank?: boolean; allReal?: boolean } = {}
    try {
      mediaParsed = JSON.parse(String(mediaLabels))
    } catch {
      // 'none' or error → fails below
    }
    const mediaOk = mediaParsed.allBlank === true
    if (mediaOk) pass++
    console.log(`${mediaOk ? 'PASS' : 'FAIL'}  mediaDevices labels blank: ${mediaLabels}`)

    // mediaDevices entries must remain real MediaDeviceInfo (instanceof survives).
    const mediaRealOk = mediaParsed.allReal === true
    if (mediaRealOk) pass++
    console.log(`${mediaRealOk ? 'PASS' : 'FAIL'}  mediaDevices real MediaDeviceInfo: ${mediaParsed.allReal}`)

    // getClientRects stays native DOMRectList (no plain-Array tell).
    const gcrOk = gcrType === true
    if (gcrOk) pass++
    console.log(`${gcrOk ? 'PASS' : 'FAIL'}  getClientRects is DOMRectList: ${gcrType}`)

    // Patched fns carry the correct .name.
    const nameChkOk = nameOk === true
    if (nameChkOk) pass++
    console.log(`${nameChkOk ? 'PASS' : 'FAIL'}  patched fn .name correct: ${nameOk}`)

    const TOTAL = 14
    console.log(`\n${pass}/${TOTAL} checks passed.`)
    conn.close()
    process.exitCode = pass === TOTAL ? 0 : 1
  } finally {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }
}

main().catch((e) => {
  console.error('verify error:', e)
  process.exitCode = 2
})
