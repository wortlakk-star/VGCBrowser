// ── VGC Browser — DEEP fingerprint audit ─────────────────────────────────────
// Beyond verify-correlation (cross-profile) and verify-tells (tamper): this sweeps the
// LONG TAIL of surfaces a top detector (creepjs / fingerprint.com / browserscan /
// pixelscan / iphey) reads, hunting for THREE failure classes on the deployed 2.1.56
// engine — run WITH the full native --vgc-* switch set + guard, exactly like a real
// profile launch:
//   1. MACHINE LEAK   — a value that exposes the real device (real cores/RAM/disk/GPU/IP)
//   2. COHERENCE      — a value that contradicts the claimed OS / UA / spoof
//   3. TELL           — a sign the browser is instrumented/spoofed
//
// Run:  npm run verify:deep [enginePath]     (REAL_CORES=.. REAL_MEM=.. to flag leaks)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection } from '../src/main/cdp'
import { seedFromString } from '../src/main/fingerprint-script'
import { ensureNativeGuardExtension } from '../src/main/webrtc-guard'
import { generateFingerprint } from '../src/shared/fingerprint'
import type { Fingerprint } from '../src/shared/types'
import { createLoopbackPage, openNativePage, resolveTestEngine } from './native-harness'

const ENGINE = resolveTestEngine(process.argv[2])

async function evaluate(conn: CdpConnection, sid: string, expr: string): Promise<unknown> {
  const res = (await conn.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid
  )) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }
  if (res.exceptionDetails) return 'THREW:' + (res.exceptionDetails.exception?.description || '')
  return res.result?.value
}

const PROBE = `(async () => {
  const o = {}; const n = navigator;
  const safe = (f) => { try { return f(); } catch(e){ return 'ERR:'+e; } };

  // ── memory / storage / hardware class ──
  o.jsHeapLimit = safe(() => performance.memory ? performance.memory.jsHeapSizeLimit : 'no-perf-memory');
  o.deviceMemory = n.deviceMemory;
  o.cores = n.hardwareConcurrency;
  o.storage = await (async()=>{ try { const e = await navigator.storage.estimate(); return {quota: e.quota, usage: e.usage}; } catch(x){ return 'ERR'; } })();

  // ── navigator scalar surface ──
  o.webdriver = n.webdriver;
  o.pdfViewerEnabled = n.pdfViewerEnabled;
  o.cookieEnabled = n.cookieEnabled;
  o.doNotTrack = n.doNotTrack;
  o.maxTouchPoints = n.maxTouchPoints;
  o.oscpu = n.oscpu;              // Firefox-only; present ⇒ tell
  o.productSub = n.productSub;    // Chrome = "20030107"
  o.vendorSub = n.vendorSub;
  o.vendor = n.vendor;            // "Google Inc."
  o.buildID = n.buildID;         // Firefox-only
  o.platform = n.platform;
  o.language = n.language;
  o.languages = (n.languages||[]).join(',');

  // ── UA-CH full high entropy ──
  o.uaData = await (async()=>{ try { const h = await n.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList','wow64','formFactors']); return {mobile:n.userAgentData.mobile, platform:n.userAgentData.platform, brands:n.userAgentData.brands.map(b=>b.brand+':'+b.version).join('|'), arch:h.architecture, bitness:h.bitness, model:h.model, pv:h.platformVersion, fv:h.uaFullVersion, fvl:(h.fullVersionList||[]).map(b=>b.brand+':'+b.version).join('|'), wow64:h.wow64, ff:(h.formFactors||[]).join(',')}; } catch(e){ return 'ERR:'+e; } })();

  // ── window.chrome + automation markers ──
  o.chrome = { has: !!window.chrome, keys: window.chrome?Object.keys(window.chrome).join(','):'', runtime: !!(window.chrome&&window.chrome.runtime), loadTimes: !!(window.chrome&&window.chrome.loadTimes), csi: !!(window.chrome&&window.chrome.csi) };
  o.cdcProps = safe(() => Object.getOwnPropertyNames(window).concat(Object.getOwnPropertyNames(document)).filter(k=>/\\$cdc_|\\$chrome_|__nightmare|__selenium|__webdriver|domAutomation|_phantom|callSelenium/i.test(k)).join(','));
  o.docWebdriverAttr = safe(() => document.documentElement.getAttribute('webdriver'));
  o.navProto = safe(() => n.webdriver === false && !('webdriver' in Object.getPrototypeOf(n)) ? 'own-or-clean' : ('webdriver' in Object.getPrototypeOf(n) ? 'on-proto(ok)' : 'weird'));

  // ── permissions coherence (Notification.permission vs permissions.query) ──
  o.notifPerm = safe(() => Notification.permission);
  o.permQuery = await (async()=>{ try { const p = await n.permissions.query({name:'notifications'}); return p.state; } catch(e){ return 'ERR'; } })();

  // ── WebGL2 caps / precision / extensions / context attrs ──
  o.webgl = safe(() => {
    const c = document.createElement('canvas'); const g = c.getContext('webgl2')||c.getContext('webgl');
    const dbg = g.getExtension('WEBGL_debug_renderer_info');
    const hp = g.getShaderPrecisionFormat(g.FRAGMENT_SHADER, g.HIGH_FLOAT);
    return { ver: g.getParameter(g.VERSION), sl: g.getParameter(g.SHADING_LANGUAGE_VERSION),
      vendor: dbg?g.getParameter(dbg.UNMASKED_VENDOR_WEBGL):'?', renderer: dbg?g.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'?',
      maxTex: g.getParameter(g.MAX_TEXTURE_SIZE), maxVp: (g.getParameter(g.MAX_VIEWPORT_DIMS)||[]).join('x'),
      maxRb: g.getParameter(g.MAX_RENDERBUFFER_SIZE), maxVa: g.getParameter(g.MAX_VERTEX_ATTRIBS),
      hp: hp?hp.precision+'/'+hp.rangeMax:'?', extCount: (g.getSupportedExtensions()||[]).length,
      aa: g.getContextAttributes()?g.getContextAttributes().antialias:'?' };
  });

  // ── codecs (reveal OS/hardware codec support) ──
  o.codecs = safe(() => {
    const v = document.createElement('video'); const a = document.createElement('audio');
    return [ 'v.h264:'+v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      'v.hevc:'+v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"'),
      'v.vp9:'+v.canPlayType('video/webm; codecs="vp9"'),
      'v.av1:'+v.canPlayType('video/mp4; codecs="av01.0.05M.08"'),
      'a.aac:'+a.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      'a.eac3:'+a.canPlayType('audio/mp4; codecs="ec-3"') ].join(' ');
  });
  o.mediaCap = await (async()=>{ try { const r = await navigator.mediaCapabilities.decodingInfo({type:'file',video:{contentType:'video/mp4;codecs="avc1.42E01E"',width:1920,height:1080,bitrate:2000000,framerate:30}}); return 'h264 sup='+r.supported+' smooth='+r.smooth+' power='+r.powerEfficient; } catch(e){ return 'ERR'; } })();

  // ── audio hardware ──
  o.audio = safe(() => { const ac = new (window.AudioContext||window.webkitAudioContext)(); const r = {sr: ac.sampleRate, base: ac.baseLatency, ch: ac.destination.maxChannelCount, state: ac.state}; ac.close(); return r; });

  // ── API presence (OS/device-dependent) ──
  o.apis = safe(() => ['getBattery' in navigator, 'bluetooth' in navigator, 'usb' in navigator, 'serial' in navigator, 'hid' in navigator, 'requestMIDIAccess' in navigator, 'xr' in navigator, 'DeviceOrientationEvent' in window, 'DeviceMotionEvent' in window, 'Accelerometer' in window, 'Gyroscope' in window, 'ondevicelight' in window].map((v,i)=>['battery','bt','usb','serial','hid','midi','xr','devorient','devmotion','accel','gyro','devlight'][i]+':'+(v?1:0)).join(' '));
  o.battery = await (async()=>{ try { if(!('getBattery' in navigator)) return 'no-api'; const b = await navigator.getBattery(); return 'charging='+b.charging+' level='+b.level; } catch(e){ return 'ERR'; } })();

  // ── Intl / timezone / date coherence ──
  const ro = Intl.DateTimeFormat().resolvedOptions();
  o.intl = { tz: ro.timeZone, locale: ro.locale, cal: ro.calendar, num: ro.numberingSystem };
  o.dateOffset = new Date(2025,0,15).getTimezoneOffset();
  o.dateStr = new Date(1700000000000).toString();

  // ── error stack (does it leak the injected script?) ──
  o.stack = safe(() => { try { null.x; } catch(e){ return String(e.stack).split(String.fromCharCode(10)).slice(0,3).join(' | '); } });

  // ── cross-realm Function.prototype.toString on key patched natives ──
  o.crossRealm = safe(() => {
    const f = document.createElement('iframe'); f.style.display='none'; document.documentElement.appendChild(f);
    const t = f.contentWindow.Function.prototype.toString;
    const test = (fn) => { const s = t.call(fn); return /\\{\\s*\\[native code\\]\\s*\\}/.test(s); };
    const r = { hc: test(Object.getOwnPropertyDescriptor(Navigator.prototype,'hardwareConcurrency').get),
      sw: test(Object.getOwnPropertyDescriptor(Screen.prototype,'width').get),
      gbcr: test(Element.prototype.getBoundingClientRect),
      rtt: (()=>{try{return test(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator.connection),'rtt').get);}catch(e){return 'n/a';}})(),
      getVoices: (()=>{try{return test(SpeechSynthesis.prototype.getVoices);}catch(e){return 'n/a';}})() };
    f.remove(); return r;
  });

  // ── speech voices (OS reveal + per-profile) ──
  o.voices = await (async()=>{ try { let v = speechSynthesis.getVoices(); if(!v.length){ await new Promise(r=>setTimeout(r,500)); v = speechSynthesis.getVoices(); } return v.map(x=>x.name).join('|'); } catch(e){ return 'ERR'; } })();

  // ── matchMedia coherence with dpr + screen ──
  o.mm = safe(() => ({ dpr: devicePixelRatio,
    res: matchMedia('(resolution: '+devicePixelRatio+'dppx)').matches,
    dw: matchMedia('(device-width: '+screen.width+'px)').matches,
    pointer: matchMedia('(pointer: fine)').matches, hover: matchMedia('(hover: hover)').matches,
    darkScheme: matchMedia('(prefers-color-scheme: dark)').matches,
    gamut: ['srgb','p3','rec2020'].filter(g=>matchMedia('(color-gamut: '+g+')').matches).join(',') }));

  // ── fonts: three detection methods must AGREE (check vs measureText vs offsetWidth) ──
  o.fontAgree = safe(() => {
    const test = 'Malgun Gothic';
    const check = document.fonts.check('12px "'+test+'"');
    const cx = document.createElement('canvas').getContext('2d');
    cx.font = '40px "'+test+'", monospace'; const w1 = cx.measureText('mmmlliW').width;
    cx.font = '40px monospace'; const w2 = cx.measureText('mmmlliW').width;
    const measureInstalled = w1 !== w2;
    const sp = document.createElement('span'); sp.textContent='mmmlliW'; sp.style.cssText='position:absolute;font-size:40px;font-family:"'+test+'",monospace';
    document.body.appendChild(sp); const ow1 = sp.offsetWidth; sp.style.fontFamily='monospace'; const ow2 = sp.offsetWidth; document.body.removeChild(sp);
    const offsetInstalled = ow1 !== ow2;
    return { check, measureInstalled, offsetInstalled, agree: (check===measureInstalled && check===offsetInstalled) };
  });

  return o;
})()`

interface Probe { [k: string]: unknown }

async function launch(fp: Fingerprint, id: string, pageUrl: string): Promise<Probe> {
  const udd = mkdtempSync(join(tmpdir(), 'vgc-deep-'))
  const seed = seedFromString(id)
  const guardExt = ensureNativeGuardExtension(udd, fp)
  const langs = fp.languages && fp.languages.length ? fp.languages : [fp.language]
  const uaPlatform = fp.platform === 'MacIntel' ? 'macOS' : fp.platform.startsWith('Linux') ? 'Linux' : 'Windows'
  const uaArch = uaPlatform === 'macOS' && /apple/i.test(fp.webgl.renderer) ? 'arm' : 'x86'
  const args = [
    `--user-data-dir=${udd}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--hide-crash-restore-bubble',
    ...(process.env.HEADFUL ? [] : ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    `--lang=${fp.language}`, `--window-size=${fp.screen.width},${fp.screen.height - 40}`,
    `--user-agent=${fp.userAgent}`, `--vgc-ua-full-version=${fp.uaFullVersion || ''}`,
    `--vgc-ua-platform=${uaPlatform}`, `--vgc-ua-platform-version=${fp.uaPlatformVersion || ''}`,
    `--vgc-ua-arch=${uaArch}`, '--vgc-ua-bitness=64',
    `--vgc-hardware-concurrency=${fp.hardwareConcurrency}`, `--vgc-device-memory=${fp.deviceMemory}`,
    `--vgc-platform=${fp.platform}`, `--vgc-webgl-vendor=${fp.webgl.vendor}`, `--vgc-webgl-renderer=${fp.webgl.renderer}`,
    `--vgc-timezone=${fp.timezone}`, `--vgc-accept-languages=${langs.join(',')}`,
    ...(fp.fonts && fp.fonts.length ? [`--vgc-fonts=${fp.fonts.join(',')}`] : []),
    `--vgc-screen=${fp.screen.width}x${fp.screen.height}`, `--vgc-color-depth=${fp.screen.colorDepth}`,
    `--vgc-seed=${seed}`, `--vgc-profile-name=${id}`,
    ...(guardExt ? [`--load-extension=${guardExt}`, `--disable-extensions-except=${guardExt}`] : []),
    'about:blank'
  ]
  const browser = await openNativePage(ENGINE, args, pageUrl)
  try {
    return (await evaluate(browser.conn, browser.sessionId, PROBE)) as Probe
  } finally {
    await browser.close()
    rmSync(udd, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  console.log('engine:', ENGINE)
  const os = process.env.VGC_OS === 'windows' || process.env.VGC_OS === 'linux' || process.env.VGC_OS === 'macos'
    ? process.env.VGC_OS
    : process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  const fp = generateFingerprint(os)
  console.log(`profile: ${fp.hardwareConcurrency}c/${fp.deviceMemory}GB ${fp.screen.width}x${fp.screen.height} ${fp.webgl.renderer.slice(0, 50)} tz=${fp.timezone}`)
  const page = await createLoopbackPage()
  const r = await launch(fp, 'deep-audit-profile', page.url).finally(() => page.close())
  console.log('\n===== RAW =====')
  console.log(JSON.stringify(r, null, 1))

  const REAL_CORES = process.env.REAL_CORES || ''
  const REAL_MEM = process.env.REAL_MEM || ''
  const leaks: string[] = []
  const coh: string[] = []
  const tells: string[] = []

  // machine leaks
  if (String(r.cores) === REAL_CORES) leaks.push(`hardwareConcurrency = real ${REAL_CORES}`)
  // jsHeapSizeLimit must be COHERENT with the claimed deviceMemory: a ≤4GB machine reports
  // ~2.14GB; only ≥8GB reports 4.4GB. A small-RAM claim beside a big heap is the leak.
  const heap = Number(r.jsHeapLimit)
  const dm = Number(r.deviceMemory)
  if (heap && dm <= 4 && heap > 2600000000)
    leaks.push(`jsHeapSizeLimit ${(heap / 1e9).toFixed(2)}GB incoherent with deviceMemory=${dm} (≤4GB → ~2.14GB)`)
  const wv = r.webgl as { renderer?: string; maxTex?: number } | string
  if (typeof wv === 'object' && wv.renderer && /SwiftShader|llvmpipe|Software/i.test(wv.renderer))
    leaks.push(`WebGL renderer software-rasteriser (${wv.renderer})`)

  // tells
  if (r.webdriver !== false) tells.push(`navigator.webdriver = ${r.webdriver}`)
  if (r.cdcProps) tells.push(`automation props: ${r.cdcProps}`)
  if (r.docWebdriverAttr) tells.push(`documentElement[webdriver] = ${r.docWebdriverAttr}`)
  if (String(r.oscpu) !== 'undefined' && r.oscpu) tells.push(`navigator.oscpu present (Firefox-only): ${r.oscpu}`)
  if (r.buildID) tells.push(`navigator.buildID present (Firefox-only)`)
  const ch = r.chrome as { has: boolean; keys: string }
  if (!ch.has) tells.push(`window.chrome MISSING`)
  const cr = r.crossRealm as Record<string, unknown>
  if (cr && typeof cr === 'object')
    for (const [k, v] of Object.entries(cr))
      if (v === false) tells.push(`cross-realm toString NOT native: ${k}`)
  if (String(r.stack).match(/vgc|inject|guard|extension/i)) tells.push(`error stack leaks injection: ${r.stack}`)
  // FontFaceSet.check() is ALWAYS true for a system-font family (even a nonexistent one) — it
  // only tracks loadable @font-face objects — so it is NOT part of the invariant (stock Chrome
  // has check=true/measure=false for any not-installed font). The real invariant: the two
  // RELIABLE detection methods (measureText width, layout offsetWidth) must AGREE, so a
  // VGC-hidden font is indistinguishable from a genuinely not-installed one.
  const fa = r.fontAgree as { measureInstalled?: boolean; offsetInstalled?: boolean }
  if (fa && typeof fa === 'object' && fa.measureInstalled !== fa.offsetInstalled)
    tells.push(`font measure/offset DISAGREE: measure=${fa.measureInstalled} offset=${fa.offsetInstalled}`)

  // coherence
  const ua = r.uaData as { platform?: string; mobile?: boolean; arch?: string; fv?: string; fvl?: string }
  const expectedUaPlatform = fp.platform === 'MacIntel' ? 'macOS' : fp.platform.startsWith('Linux') ? 'Linux' : 'Windows'
  if (typeof ua === 'object') {
    if (ua.platform !== expectedUaPlatform) coh.push(`UA-CH platform ${ua.platform} != ${expectedUaPlatform}`)
    if (ua.mobile !== false) coh.push(`UA-CH mobile = ${ua.mobile}`)
    if (!ua.fvl) coh.push(`UA-CH fullVersionList empty`)
  }
  if (String(r.platform) !== fp.platform) coh.push(`navigator.platform ${r.platform} != ${fp.platform}`)
  if (![0.25, 0.5, 1, 2, 4, 8].includes(Number(r.deviceMemory))) coh.push(`deviceMemory ${r.deviceMemory} not a Chrome value`)
  if (String(r.vendor) !== 'Google Inc.') coh.push(`navigator.vendor = ${r.vendor}`)
  if (String(r.productSub) !== '20030107') coh.push(`navigator.productSub = ${r.productSub} (Chrome=20030107)`)
  if (Number(r.maxTouchPoints) !== 0) coh.push(`maxTouchPoints ${r.maxTouchPoints} (desktop should be 0)`)
  const mm = r.mm as { res?: boolean; dw?: boolean; pointer?: boolean }
  if (mm && typeof mm === 'object') {
    if (mm.res === false) coh.push(`matchMedia resolution != devicePixelRatio`)
    if (mm.dw === false) coh.push(`matchMedia device-width != screen.width`)
    if (mm.pointer === false) coh.push(`matchMedia (pointer:fine) false on desktop`)
  }
  const np = r.notifPerm, pq = r.permQuery
  if (np === 'denied' && pq !== 'denied') coh.push(`Notification.permission=${np} but permissions.query=${pq}`)

  const P = (t: string, a: string[]): void => {
    console.log(`\n${a.length ? '🔴' : '🟢'} ${t}: ${a.length}`)
    a.forEach((x) => console.log(`   - ${x}`))
  }
  console.log('\n===== DEEP AUDIT VERDICT =====')
  P('PHYSICAL-MACHINE LEAKS', leaks)
  P('TAMPER TELLS', tells)
  P('COHERENCE ISSUES', coh)
  process.exitCode = leaks.length || tells.length || coh.length ? 1 : 0
}

main().catch((e) => {
  console.error('deep audit error:', e)
  process.exitCode = 2
})
