// ── VGC Browser — toString-integrity audit ───────────────────────────────────
// The nat()/xnat() Proxy-over-native masking keeps "[native code]" in every realm but DROPS the
// function NAME: Function.prototype.toString.call(proxy) → "function () { [native code] }" instead
// of "function matchMedia() { [native code] }". A detector that reconstructs/compares
// `fn.toString() === 'function '+fn.name+'() { [native code] }'` catches that (it broke Cloudflare
// Turnstile via matchMedia). This sweeps EVERY commonly-fingerprinted function + getter on the
// DEPLOYED native engine (guard + --vgc-* flags) and flags any that is:
//   • SOURCE-LEAK  — toString shows our JS (worst), or
//   • ANON         — "[native code]" but the NAME is missing though it should be there (the Proxy tell)
// Run:  npm run verify:tostring [enginePath]

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection, getBrowserWsUrl } from '../src/main/cdp'
import { seedFromString } from '../src/main/fingerprint-script'
import { ensureNativeGuardExtension } from '../src/main/webrtc-guard'
import { generateFingerprint } from '../src/shared/fingerprint'
import type { Fingerprint } from '../src/shared/types'

const ENGINE =
  process.argv[2] || join(process.env.APPDATA || '', 'vgc-browser', 'engine', 'chromium', 'chrome.exe')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Each entry: [ownerExpr, propName, 'fn'|'getter']. Checked on the prototype/global where it lives.
const TARGETS = `[
  // ── canvas (native C++ on the engine → must stay named/native) ──
  [HTMLCanvasElement.prototype,'toDataURL','fn'],
  [HTMLCanvasElement.prototype,'toBlob','fn'],
  [CanvasRenderingContext2D.prototype,'getImageData','fn'],
  [CanvasRenderingContext2D.prototype,'fillText','fn'],
  [window.OffscreenCanvas?OffscreenCanvas.prototype:{},'convertToBlob','fn'],
  // ── WebGL ──
  [WebGLRenderingContext.prototype,'getParameter','fn'],
  [window.WebGL2RenderingContext?WebGL2RenderingContext.prototype:{},'getParameter','fn'],
  [WebGLRenderingContext.prototype,'getExtension','fn'],
  [WebGLRenderingContext.prototype,'readPixels','fn'],
  // ── audio ──
  [window.OfflineAudioContext?OfflineAudioContext.prototype:{},'startRendering','fn'],
  [window.AudioBuffer?AudioBuffer.prototype:{},'getChannelData','fn'],
  // ── layout / screen / media queries ──
  [Element.prototype,'getBoundingClientRect','fn'],
  [Element.prototype,'getClientRects','fn'],
  [window,'matchMedia','fn'],
  // ── speech / media devices (stealth-extra wraps these) ──
  [window.SpeechSynthesis?SpeechSynthesis.prototype:{},'getVoices','fn'],
  [window.MediaDevices?MediaDevices.prototype:{},'enumerateDevices','fn'],
  [window.MediaDeviceInfo?MediaDeviceInfo.prototype:{},'toJSON','fn'],
  // ── navigator / permissions / rtc ──
  [Navigator.prototype,'getGamepads','fn'],
  [window.Permissions?Permissions.prototype:{},'query','fn'],
  // ── navigator scalar GETTERS ──
  [Navigator.prototype,'hardwareConcurrency','getter'],
  [Navigator.prototype,'deviceMemory','getter'],
  [Navigator.prototype,'platform','getter'],
  [Navigator.prototype,'vendor','getter'],
  [Navigator.prototype,'userAgent','getter'],
  [Navigator.prototype,'languages','getter'],
  [Navigator.prototype,'webdriver','getter'],
  // ── screen GETTERS ──
  [Screen.prototype,'width','getter'],
  [Screen.prototype,'height','getter'],
  [Screen.prototype,'availWidth','getter'],
  [Screen.prototype,'availLeft','getter'],
  [Screen.prototype,'availTop','getter'],
  [Screen.prototype,'colorDepth','getter'],
  // ── connection / memory / media-device label GETTERS ──
  [window.NetworkInformation?NetworkInformation.prototype:{},'rtt','getter'],
  [window.NetworkInformation?NetworkInformation.prototype:{},'downlink','getter'],
  [window.MediaDeviceInfo?MediaDeviceInfo.prototype:{},'label','getter'],
  [(window.performance&&performance.memory)?Object.getPrototypeOf(performance.memory):{},'jsHeapSizeLimit','getter']
]`

const PROBE = `(() => {
  var out = [];
  var iframe = document.createElement('iframe'); iframe.style.display='none'; document.documentElement.appendChild(iframe);
  var altToString = iframe.contentWindow.Function.prototype.toString; // cross-realm toString (the creepjs check)
  var targets = ${TARGETS};
  for (var i=0;i<targets.length;i++){
    try {
      var owner = targets[i][0], name = targets[i][1], kind = targets[i][2];
      if (!owner || typeof owner !== 'object') continue;
      var d = Object.getOwnPropertyDescriptor(owner, name);
      if (!d) continue;
      var fn = kind === 'getter' ? d.get : d.value;
      if (typeof fn !== 'function') continue;
      var s = altToString.call(fn);               // cross-realm — the strict path
      var hasNative = s.indexOf('[native code]') !== -1;
      var expectName = kind === 'getter' ? ('get ' + name) : name;
      // native form: "function <name>(" or "function get <name>(" (accessor) or "get <name>("
      var hasName = s.indexOf('function ' + expectName + '(') === 0 ||
                    s.indexOf(expectName + '(') !== -1 ||
                    s.indexOf('function ' + name + '(') === 0;
      var verdict = !hasNative ? 'SOURCE-LEAK' : (!hasName ? 'ANON' : 'ok');
      out.push({ t: name + (kind==='getter'?' (get)':''), v: verdict, s: s.replace(/\\s+/g,' ').slice(0,54) });
    } catch(e){ out.push({ t: targets[i][1], v: 'ERR', s: String(e).slice(0,40) }); }
  }
  iframe.remove();
  return JSON.stringify(out);
})()`

async function main(): Promise<void> {
  const fp: Fingerprint = generateFingerprint('windows')
  const id = 'tostring-audit'
  const udd = mkdtempSync(join(tmpdir(), 'vgc-ts-'))
  const seed = seedFromString(id)
  const guardExt = ensureNativeGuardExtension(udd, fp, seed)
  const langs = fp.languages && fp.languages.length ? fp.languages : [fp.language]
  const args = [
    `--user-data-dir=${udd}`, '--remote-debugging-port=9637', '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--lang=${fp.language}`, `--user-agent=${fp.userAgent}`,
    `--vgc-hardware-concurrency=${fp.hardwareConcurrency}`, `--vgc-device-memory=${fp.deviceMemory}`,
    `--vgc-platform=${fp.platform}`, `--vgc-webgl-vendor=${fp.webgl.vendor}`, `--vgc-webgl-renderer=${fp.webgl.renderer}`,
    `--vgc-timezone=${fp.timezone}`, `--vgc-accept-languages=${langs.join(',')}`,
    ...(fp.fonts && fp.fonts.length ? [`--vgc-fonts=${fp.fonts.join(',')}`] : []),
    `--vgc-screen=${fp.screen.width}x${fp.screen.height}`, `--vgc-color-depth=${fp.screen.colorDepth}`,
    `--vgc-seed=${seed}`, `--vgc-profile-name=${id}`,
    ...(guardExt ? [`--load-extension=${guardExt}`, `--disable-extensions-except=${guardExt}`] : []),
    'about:blank'
  ]
  const proc = spawn(ENGINE, args)
  try {
    const conn = await CdpConnection.connect(await getBrowserWsUrl(9637))
    const c = (await conn.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
    const a = (await conn.send('Target.attachToTarget', { targetId: c.targetId, flatten: true })) as { sessionId: string }
    await conn.send('Runtime.enable', {}, a.sessionId)
    await conn.send('Page.navigate', { url: 'https://example.com' }, a.sessionId)
    await sleep(3500)
    const res = (await conn.send(
      'Runtime.evaluate',
      { expression: PROBE, returnByValue: true },
      a.sessionId
    )) as { result?: { value?: unknown } }
    const rows = JSON.parse(String(res.result?.value)) as { t: string; v: string; s: string }[]
    conn.close()
    const bad = rows.filter((r) => r.v === 'SOURCE-LEAK' || r.v === 'ANON')
    console.log('engine:', ENGINE, '\n')
    for (const r of rows) {
      const icon = r.v === 'ok' ? '🟢' : r.v === 'ANON' ? '🟡' : r.v === 'ERR' ? '· ' : '🔴'
      if (r.v !== 'ok') console.log(`${icon} ${r.v.padEnd(11)} ${r.t.padEnd(28)} ${r.s}`)
    }
    console.log(`\n${rows.filter((r) => r.v === 'ok').length} native-ok · ${bad.filter((b) => b.v === 'ANON').length} ANON (name dropped) · ${bad.filter((b) => b.v === 'SOURCE-LEAK').length} SOURCE-LEAK`)
    const leaks = bad.filter((b) => b.v === 'SOURCE-LEAK')
    const anon = bad.filter((b) => b.v === 'ANON')
    console.log(leaks.length ? '🔴 SOURCE LEAK — our JS is visible!' : anon.length ? '🟡 anonymous-name tells present (Proxy name-drop)' : '🟢 all fingerprint fns/getters report native WITH name')
    process.exitCode = leaks.length ? 2 : anon.length ? 1 : 0
  } finally {
    try { proc.kill() } catch { /* */ }
  }
}
main().catch((e) => { console.error('audit error:', e); process.exitCode = 3 })
