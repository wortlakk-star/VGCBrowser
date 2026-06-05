// ── VGC Browser — VGC Core NATIVE fingerprint verification ───────────────────
// Launches the built engine (out/Default/chrome.exe) with ONLY the --vgc-*
// switches (NO JS/CDP injection) and reads the values back. If they match the
// switches, the C++ patches work — i.e. the spoof is native (undetectable by JS
// introspection), the whole point of VGC Core.

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection, getBrowserWsUrl } from '../src/main/cdp'

const ENGINE = 'D:\\chromium\\src\\out\\Default\\chrome.exe'
const PORT = 9556
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function evaluate(conn: CdpConnection, sid: string, expr: string): Promise<unknown> {
  const res = (await conn.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid
  )) as { result?: { value?: unknown } }
  return res.result?.value
}

async function main(): Promise<void> {
  const udd = mkdtempSync(join(tmpdir(), 'vgc-core-'))
  const VENDOR = 'Google Inc. (NVIDIA)'
  const RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'

  const proc = spawn(ENGINE, [
    `--user-data-dir=${udd}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--vgc-hardware-concurrency=8',
    '--vgc-device-memory=16',
    `--vgc-webgl-vendor=${VENDOR}`,
    `--vgc-webgl-renderer=${RENDERER}`,
    'about:blank'
  ])

  try {
    const ws = await getBrowserWsUrl(PORT)
    const conn = await CdpConnection.connect(ws)
    const created = (await conn.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string
    }
    const att = (await conn.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true
    })) as { sessionId: string }
    const sid = att.sessionId
    await conn.send('Page.enable', {}, sid)
    await conn.send('Runtime.enable', {}, sid)
    // Secure context so navigator.deviceMemory is exposed.
    await conn.send('Page.navigate', { url: 'https://example.com' }, sid)
    await sleep(3000)

    const cores = await evaluate(conn, sid, 'navigator.hardwareConcurrency')
    const mem = await evaluate(conn, sid, 'navigator.deviceMemory')
    const gl = await evaluate(
      conn,
      sid,
      '(function(){try{var c=document.createElement("canvas");var g=c.getContext("webgl")||c.getContext("experimental-webgl");var e=g.getExtension("WEBGL_debug_renderer_info");if(!e)return "no-ext";return JSON.stringify({vendor:g.getParameter(e.UNMASKED_VENDOR_WEBGL),renderer:g.getParameter(e.UNMASKED_RENDERER_WEBGL)});}catch(err){return "ERR:"+err;}})()'
    )

    console.log('\n=== VGC Core NATIVE spoof (no JS injection) ===')
    let pass = 0
    const ok = (name: string, got: unknown, cond: boolean): void => {
      if (cond) pass++
      console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(got)}`)
    }
    ok('hardwareConcurrency=8', cores, cores === 8)
    ok('deviceMemory=16', mem, mem === 16)
    ok('webgl vendor/renderer', gl, String(gl).includes('NVIDIA') && String(gl).includes('RTX 3060'))

    console.log(`\n${pass}/3 native checks passed.`)
    conn.close()
    process.exitCode = pass === 3 ? 0 : 1
  } finally {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('engine verify error:', e)
  process.exitCode = 2
})
