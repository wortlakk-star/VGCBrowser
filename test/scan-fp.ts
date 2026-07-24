// ── VGC Browser — live fingerprint leak scan (Windows) ───────────────────────
// Launches the REAL engine with the SAME switches profile-manager.ts passes for a
// Windows profile, then reads a wide battery of signals back out and checks them
// against each other. Unlike verify-injection (which asserts a handful of values
// were spoofed), this looks for CONTRADICTIONS and TELLS — what an anti-bot system
// actually scores.
//
// Run:  npx esbuild test/scan-fp.ts --bundle --platform=node --format=cjs \
//         --external:bufferutil --external:utf-8-validate --outfile=test/scan.cjs \
//         && node test/scan.cjs [pathToChrome.exe]

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection, getBrowserWsUrl } from '../src/main/cdp'
import { seedFromString } from '../src/main/fingerprint-script'
import { generateFingerprint } from '../src/shared/fingerprint'

const DEFAULT_ENGINE = join(
  process.env.APPDATA || '',
  'vgc-browser',
  'engine',
  'chromium',
  'chrome.exe'
)
const ENGINE = process.argv[2] || DEFAULT_ENGINE
const PORT = 9571
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function evaluate(conn: CdpConnection, sid: string, expr: string): Promise<unknown> {
  const res = (await conn.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid
  )) as { result?: { value?: unknown } }
  return res.result?.value
}

// Everything we want to know, collected in one page evaluation.
const PROBE = `(async () => {
  const out = {};
  const n = navigator;
  out.ua = n.userAgent;
  out.platform = n.platform;
  out.cores = n.hardwareConcurrency;
  out.mem = n.deviceMemory;
  out.langs = n.languages;
  out.lang = n.language;
  out.webdriver = n.webdriver;
  out.vendor = n.vendor;
  out.maxTouchPoints = n.maxTouchPoints;
  out.pdfViewerEnabled = n.pdfViewerEnabled;
  out.plugins = Array.prototype.map.call(n.plugins, p => p.name);
  out.mimeTypes = n.mimeTypes.length;

  try {
    out.uaData = { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform };
    out.hints = await n.userAgentData.getHighEntropyValues(
      ['platform','platformVersion','architecture','bitness','model','uaFullVersion','fullVersionList','wow64']);
  } catch (e) { out.uaData = 'ERR:' + e; }

  out.screen = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight,
                 cd: screen.colorDepth, pd: screen.pixelDepth, dpr: devicePixelRatio,
                 outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight] };

  const ro = Intl.DateTimeFormat().resolvedOptions();
  out.tz = { intl: ro.timeZone, locale: ro.locale, offsetMinutes: new Date().getTimezoneOffset(),
             janOffset: new Date(2025,0,1).getTimezoneOffset(), julOffset: new Date(2025,6,1).getTimezoneOffset(),
             str: new Date(2025,0,15,12,0,0).toString() };

  try {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!g) { out.webgl = 'NO-GL-CONTEXT'; throw new Error('no webgl context'); }
    const e = g.getExtension('WEBGL_debug_renderer_info');
    out.webgl = { unmaskedVendor: e ? g.getParameter(e.UNMASKED_VENDOR_WEBGL) : null,
                  unmaskedRenderer: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : null,
                  vendor: g.getParameter(g.VENDOR), renderer: g.getParameter(g.RENDERER),
                  version: g.getParameter(g.VERSION),
                  maxTexture: g.getParameter(g.MAX_TEXTURE_SIZE),
                  extCount: g.getSupportedExtensions().length };
  } catch (e) { out.webgl = 'ERR:' + e; }

  // canvas + audio stability: hash twice, must be identical within a page
  function canvasHash() {
    const c = document.createElement('canvas'); c.width = 220; c.height = 50;
    const x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '14px Arial'; x.fillStyle = '#069';
    x.fillText('VGC fingerprint test', 2, 2);
    return c.toDataURL().slice(-32);
  }
  out.canvas1 = canvasHash(); out.canvas2 = canvasHash();

  // JS tamper tells
  const t = (f) => { try { return Function.prototype.toString.call(f); } catch (e) { return 'THREW:' + e; } };
  out.toStrings = {
    hardwareConcurrency: t(Object.getOwnPropertyDescriptor(Navigator.prototype,'hardwareConcurrency')?.get),
    deviceMemory: t(Object.getOwnPropertyDescriptor(Navigator.prototype,'deviceMemory')?.get),
    platform: t(Object.getOwnPropertyDescriptor(Navigator.prototype,'platform')?.get),
    getParameter: t(WebGLRenderingContext.prototype.getParameter),
    toDataURL: t(HTMLCanvasElement.prototype.toDataURL),
    getClientRects: t(Element.prototype.getClientRects),
    toStringItself: t(Function.prototype.toString)
  };
  // where do the spoofed props live? own-property on navigator = tell (native is on the prototype)
  out.ownOnNavigator = ['hardwareConcurrency','deviceMemory','platform','userAgent','languages','webdriver']
    .filter(k => Object.prototype.hasOwnProperty.call(n, k));

  // leftover injected globals. NB: match only at a name boundary — a naive /vgc/i
  // also hits native "SVGComponentTransferFunctionElement" etc.
  out.vgcGlobals = Object.getOwnPropertyNames(window)
    .filter(k => /^_{0,2}(vgc|spoof|stealth|fp)([_A-Z0-9]|$)/.test(k) || /__(inject|stealth|guard)/.test(k));

  // error stack leaking the injected script
  try { null.x; } catch (e) { out.stack = String(e.stack).split('\\n').slice(0,4); }

  out.chromeObj = { hasChrome: !!window.chrome, hasRuntime: !!(window.chrome && window.chrome.runtime),
                    keys: window.chrome ? Object.keys(window.chrome) : [] };

  try {
    const p = await navigator.permissions.query({ name: 'notifications' });
    out.permissions = { state: p.state, notification: Notification.permission };
  } catch (e) { out.permissions = 'ERR:' + e; }

  return out;
})()`

// WebRTC ICE candidate probe — run separately, it needs time to gather.
const WEBRTC = `(async () => {
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('x');
    const cands = [];
    pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(r => setTimeout(r, 4000));
    pc.close();
    const ips = [...new Set(cands.join(' ').match(/(\\d{1,3}\\.){3}\\d{1,3}|[a-f0-9]{1,4}(:[a-f0-9]{0,4}){3,}/gi) || [])];
    return { count: cands.length, ips };
  } catch (e) { return { error: String(e) }; }
})()`

interface Row {
  sev: 'FAIL' | 'WARN' | 'OK'
  what: string
  detail: string
}
const rows: Row[] = []
const add = (sev: Row['sev'], what: string, detail: string): void => {
  rows.push({ sev, what, detail })
}

async function main(): Promise<void> {
  const fp = generateFingerprint('windows')
  const id = 'scan-profile-fixed-id'
  const udd = mkdtempSync(join(tmpdir(), 'vgc-scan-'))

  const langs = fp.languages && fp.languages.length ? fp.languages : [fp.language]
  const uaFull = fp.uaFullVersion || fp.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || ''

  const args = [
    `--user-data-dir=${udd}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-crash-restore-bubble',
    // Headful by DEFAULT: profiles run headful, and headless changes WebGL/plugins/
    // screen behaviour enough that scanning headless would audit the wrong browser.
    ...(process.env.HEADLESS ? ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
    `--lang=${fp.language}`,
    `--window-size=${fp.screen.width},${fp.screen.height}`,
    `--user-agent=${fp.userAgent}`,
    `--vgc-ua-full-version=${uaFull}`,
    '--vgc-ua-platform=Windows',
    `--vgc-ua-platform-version=${fp.uaPlatformVersion || '15.0.0'}`,
    '--vgc-ua-arch=x86',
    '--vgc-ua-bitness=64',
    `--vgc-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--vgc-device-memory=${fp.deviceMemory}`,
    `--vgc-platform=${fp.platform}`,
    `--vgc-webgl-vendor=${fp.webgl.vendor}`,
    `--vgc-webgl-renderer=${fp.webgl.renderer}`,
    `--vgc-timezone=${fp.timezone}`,
    `--vgc-accept-languages=${langs.join(',')}`,
    `--vgc-seed=${seedFromString(id)}`,
    '--vgc-profile-name=Scan Profile',
    'about:blank'
  ]

  console.log('engine :', ENGINE)
  console.log('profile fingerprint (expected):')
  console.log('  ua        :', fp.userAgent)
  console.log('  platform  :', fp.platform)
  console.log('  cores/mem :', fp.hardwareConcurrency, '/', fp.deviceMemory)
  console.log('  screen    :', `${fp.screen.width}x${fp.screen.height}`)
  console.log('  timezone  :', fp.timezone)
  console.log('  languages :', langs.join(','))
  console.log('  webgl     :', fp.webgl.vendor, '|', fp.webgl.renderer)

  const proc = spawn(ENGINE, args)
  proc.on('error', (e) => console.error('spawn error:', e))

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
    await conn.send('Page.navigate', { url: 'https://example.com' }, sid)
    await sleep(3500)

    const r = (await evaluate(conn, sid, PROBE)) as Record<string, unknown>
    if (!r || typeof r !== 'object') {
      console.error('probe returned nothing:', r)
      process.exitCode = 2
      return
    }

    console.log('\n===== RAW READBACK =====')
    console.log(JSON.stringify(r, null, 2))

    // ── coherence checks ──────────────────────────────────────────────────────
    const ua = String(r.ua || '')
    const uaVer = ua.match(/Chrome\/(\d+)/)?.[1] || ''
    const hints = (r.hints || {}) as Record<string, unknown>
    const uaData = (r.uaData || {}) as Record<string, unknown>
    const scr = (r.screen || {}) as Record<string, number | number[]>
    const tz = (r.tz || {}) as Record<string, unknown>
    const gl = (r.webgl || {}) as Record<string, unknown>

    // 1. UA version vs UA-CH
    const hintFull = String(hints.uaFullVersion || '')
    const hintMajor = hintFull.split('.')[0]
    add(
      uaVer && hintMajor && uaVer === hintMajor ? 'OK' : 'FAIL',
      'UA major vs UA-CH uaFullVersion',
      `UA=${uaVer} uaFullVersion=${hintFull}`
    )
    const brands = (uaData.brands || []) as { brand: string; version: string }[]
    const brandVer = brands.find((b) => /Chromium|Google Chrome/.test(b.brand))?.version
    add(
      brandVer === uaVer ? 'OK' : 'FAIL',
      'UA major vs UA-CH brand version',
      `UA=${uaVer} brands=${JSON.stringify(brands)}`
    )

    // 2. UA OS vs navigator.platform vs UA-CH platform
    const uaSaysWin = /Windows NT/.test(ua)
    add(
      uaSaysWin && r.platform === 'Win32' && hints.platform === 'Windows' ? 'OK' : 'FAIL',
      'OS coherence (UA / navigator.platform / UA-CH)',
      `uaWindows=${uaSaysWin} platform=${r.platform} hintPlatform=${hints.platform}`
    )
    add(
      hints.architecture === 'x86' && hints.bitness === '64' ? 'OK' : 'FAIL',
      'UA-CH arch/bitness populated',
      `arch="${hints.architecture}" bitness="${hints.bitness}" wow64=${hints.wow64}`
    )
    // Real Chrome NEVER returns an empty high-entropy hint. An empty string here is a
    // stronger tell than a wrong value — no genuine browser reports "".
    const emptyHints = ['platformVersion', 'architecture', 'bitness', 'uaFullVersion'].filter(
      (k) => !String(hints[k] ?? '')
    )
    add(
      emptyHints.length === 0 ? 'OK' : 'FAIL',
      'no EMPTY UA-CH high-entropy hints (real Chrome never returns "")',
      `empty=${JSON.stringify(emptyHints)}`
    )
    const fvl = (hints.fullVersionList || []) as { brand: string; version: string }[]
    add(
      fvl.length >= 3 ? 'OK' : 'FAIL',
      'UA-CH fullVersionList populated (real Chrome has 3 entries)',
      JSON.stringify(fvl)
    )
    add(
      brands.some((b) => b.brand === 'Google Chrome') ? 'OK' : 'FAIL',
      'UA-CH brands include "Google Chrome" (stock Chromium does not)',
      JSON.stringify(brands.map((b) => b.brand))
    )

    // 3. screen sanity
    const aw = Number(scr.aw)
    const ah = Number(scr.ah)
    add(
      aw <= Number(scr.w) && ah <= Number(scr.h) && aw > 0 && ah > 0 ? 'OK' : 'FAIL',
      'screen.avail <= screen',
      `${scr.w}x${scr.h} avail ${aw}x${ah}`
    )
    add(
      Number(scr.cd) === 24 && Number(scr.pd) === 24 ? 'OK' : 'WARN',
      'colorDepth/pixelDepth = 24',
      `cd=${scr.cd} pd=${scr.pd}`
    )

    // 4. timezone coherence: Intl zone vs actual Date offset
    add(
      String(tz.intl) === fp.timezone ? 'OK' : 'FAIL',
      'Intl timeZone matches profile',
      `intl=${tz.intl} want=${fp.timezone}`
    )
    add(
      tz.janOffset !== tz.julOffset || !/America|Europe/.test(String(tz.intl))
        ? 'OK'
        : 'WARN',
      'DST transition present for a DST zone',
      `jan=${tz.janOffset} jul=${tz.julOffset} zone=${tz.intl}`
    )
    add(
      /GMT[+-]\d{4}/.test(String(tz.str)) ? 'OK' : 'WARN',
      'Date.toString has a GMT offset',
      String(tz.str)
    )

    // 5. languages
    const gotLangs = (r.langs || []) as string[]
    add(
      JSON.stringify(gotLangs) === JSON.stringify(langs) ? 'OK' : 'FAIL',
      'navigator.languages matches profile',
      `got=${JSON.stringify(gotLangs)} want=${JSON.stringify(langs)}`
    )
    add(
      String(tz.locale).split('-')[0] === String(gotLangs[0] || '').split('-')[0]
        ? 'OK'
        : 'WARN',
      'Intl locale vs navigator.languages[0]',
      `locale=${tz.locale} lang0=${gotLangs[0]}`
    )

    // 6. webgl vs claimed OS
    const rend = String(gl.unmaskedRenderer || '')
    add(rend === fp.webgl.renderer ? 'OK' : 'FAIL', 'WebGL renderer matches profile', rend)
    add(
      !/Apple|Metal|AMD Radeon Pro/i.test(rend) ? 'OK' : 'FAIL',
      'WebGL renderer is plausible for Windows',
      rend
    )
    add(
      /SwiftShader|llvmpipe|Software/i.test(rend) ? 'FAIL' : 'OK',
      'WebGL renderer is not a software rasteriser',
      rend
    )

    // 7. cores / mem plausibility
    const mem = Number(r.mem)
    add(
      [0.25, 0.5, 1, 2, 4, 8].includes(mem) ? 'OK' : 'FAIL',
      'deviceMemory is a value real Chrome can report',
      `deviceMemory=${mem} (Chrome only ever reports 0.25/0.5/1/2/4/8)`
    )
    const cores = Number(r.cores)
    add(
      cores >= 2 && cores <= 32 && cores % 2 === 0 ? 'OK' : 'WARN',
      'hardwareConcurrency plausible',
      `cores=${cores}`
    )

    // 8. tamper tells
    const ts = (r.toStrings || {}) as Record<string, string>
    for (const [k, v] of Object.entries(ts)) {
      if (v === undefined || v === null) continue
      add(
        /\{\s*\[native code\]\s*\}/.test(String(v)) ? 'OK' : 'FAIL',
        `toString native for ${k}`,
        String(v).slice(0, 120)
      )
    }
    const own = (r.ownOnNavigator || []) as string[]
    add(
      own.length === 0 ? 'OK' : 'FAIL',
      'no spoofed own-properties on navigator (native lives on prototype)',
      `own=${JSON.stringify(own)}`
    )
    const globals = (r.vgcGlobals || []) as string[]
    add(globals.length === 0 ? 'OK' : 'FAIL', 'no injected globals on window', JSON.stringify(globals))
    add(
      !JSON.stringify(r.stack || []).match(/vgc|inject|stealth|guard/i) ? 'OK' : 'FAIL',
      'error stack does not name the injected script',
      JSON.stringify(r.stack)
    )
    add(String(r.webdriver) === 'false' ? 'OK' : 'FAIL', 'navigator.webdriver false', String(r.webdriver))
    add(
      r.canvas1 === r.canvas2 ? 'OK' : 'FAIL',
      'canvas hash stable within a page',
      `${r.canvas1} / ${r.canvas2}`
    )
    const plugins = (r.plugins || []) as string[]
    add(
      plugins.length >= 1 ? 'OK' : 'WARN',
      'navigator.plugins non-empty (headless Chrome tell)',
      JSON.stringify(plugins)
    )
    const chromeObj = (r.chromeObj || {}) as Record<string, unknown>
    add(chromeObj.hasChrome ? 'OK' : 'FAIL', 'window.chrome present', JSON.stringify(chromeObj.keys))

    // 9. WebRTC
    const rtc = (await evaluate(conn, sid, WEBRTC)) as { count?: number; ips?: string[] }
    console.log('\nWebRTC:', JSON.stringify(rtc))
    const ips = rtc?.ips || []
    const privateIp = ips.find((i) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i))
    add(
      !privateIp ? 'OK' : 'FAIL',
      'WebRTC does not leak a private LAN IP',
      JSON.stringify(ips)
    )

    // ── report ────────────────────────────────────────────────────────────────
    console.log('\n===== SCAN RESULT =====')
    const fails = rows.filter((x) => x.sev === 'FAIL')
    const warns = rows.filter((x) => x.sev === 'WARN')
    for (const x of rows) console.log(`${x.sev.padEnd(4)} ${x.what}\n       ${x.detail}`)
    console.log(
      `\n${rows.filter((x) => x.sev === 'OK').length} ok, ${warns.length} warn, ${fails.length} FAIL`
    )
    conn.close()
    process.exitCode = fails.length ? 1 : 0
  } finally {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('scan error:', e)
  process.exitCode = 2
})
