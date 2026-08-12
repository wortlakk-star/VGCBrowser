// ── VGC Browser — CROSS-PROFILE correlation test ─────────────────────────────
// The real antidetect question: do two DIFFERENT profiles on the SAME machine look
// like two different devices, or can Google tie them together? This launches the
// engine TWICE (two profile ids → two seeds/fingerprints), the SAME way
// profile-manager does in native mode (engine --vgc-* switches + the MV3 guard
// extension), reads a broad fingerprint back from each, and reports which signals are
// IDENTICAL across the two profiles. Every identical signal is a cross-profile
// correlator — a way to say "same machine".
//
// Run:  npm run verify:correlation

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
// Profile OS to simulate. MUST match the engine's HOST OS for the font vector to be valid:
// a Windows profile on a Mac engine can't expose Windows fonts (they aren't installed), so it
// collapses to the ~10 cross-platform core-web fonts and false-flags a font correlator. Run
// `VGC_OS=macos npm run verify:correlation -- <mac engine>` on a Mac.
const OS =
  process.env.VGC_OS === 'macos' || process.env.VGC_OS === 'linux' || process.env.VGC_OS === 'windows'
    ? process.env.VGC_OS
    : process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux'
const UA_PLATFORM = OS === 'macos' ? 'macOS' : OS === 'linux' ? 'Linux' : 'Windows'
const UA_ARCH = OS === 'macos' ? 'arm' : 'x86'

async function evaluate(conn: CdpConnection, sid: string, expr: string): Promise<unknown> {
  const res = (await conn.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid
  )) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }
  if (res.exceptionDetails) throw new Error('page: ' + (res.exceptionDetails.exception?.description || ''))
  return res.result?.value
}

// Everything a fingerprinter reads, distilled to comparable values. Font detection uses
// the classic width-probe: a glyph rendered in family X vs a guaranteed fallback — if the
// widths differ, X is installed. The vector of installed/not across many families is the
// font fingerprint, and it is IDENTICAL on two browsers of the same machine unless spoofed.
const PROBE = `(async () => {
  const o = {};
  const n = navigator;

  // ── font fingerprint (width probe) ──
  const FONTS = ['Arial','Calibri','Cambria','Cambria Math','Candara','Comic Sans MS','Consolas',
    'Constantia','Corbel','Courier New','Ebrima','Franklin Gothic','Gabriola','Gadugi','Georgia',
    'Impact','Ink Free','Javanese Text','Leelawadee UI','Lucida Console','Lucida Sans Unicode',
    'Malgun Gothic','Marlett','Microsoft Himalaya','Microsoft JhengHei','Microsoft YaHei',
    'MingLiU','MS Gothic','MS PGothic','MV Boli','Myanmar Text','Nirmala UI','Palatino Linotype',
    'Segoe Print','Segoe UI','Segoe UI Emoji','SimSun','Sitka','Sylfaen','Tahoma','Times New Roman',
    'Trebuchet MS','Verdana','Wingdings','Yu Gothic','MesloLGS NF','JetBrains Mono','Fira Code',
    'Cascadia Code','SF Pro','Helvetica Neue','Roboto','Open Sans','Ubuntu','Noto Sans',
    // macOS discriminating fonts (real fingerprinters probe these; needed to SEE per-profile
    // variation on a Mac engine — a Windows-only probe list can't and false-flags fonts as a
    // correlator because every Mac profile shares only the ~10 universal core-web fonts).
    'American Typewriter','Andale Mono','Apple Chancery','Avenir','Avenir Next','Baskerville',
    'Big Caslon','Bodoni 72','Bradley Hand','Brush Script MT','Chalkboard','Chalkduster','Cochin',
    'Copperplate','Didot','Futura','Gill Sans','Herculanum','Hoefler Text','Luminari','Marker Felt',
    'Noteworthy','Optima','Palatino','Papyrus','Phosphate','Rockwell','Savoye LET','SignPainter',
    'Skia','Snell Roundhand','Superclarendon','Trattatello','Zapfino'];
  const span = document.createElement('span');
  span.style.cssText = 'position:absolute;left:-9999px;font-size:72px';
  span.textContent = 'mmmmmmmmmmlli WwGg09';
  document.body.appendChild(span);
  const base = {};
  for (const g of ['monospace','sans-serif','serif']) { span.style.fontFamily = g; base[g] = [span.offsetWidth, span.offsetHeight]; }
  const installed = [];
  for (const f of FONTS) {
    let hit = false;
    for (const g of ['monospace','sans-serif','serif']) {
      span.style.fontFamily = "'" + f + "'," + g;
      if (span.offsetWidth !== base[g][0] || span.offsetHeight !== base[g][1]) { hit = true; break; }
    }
    if (hit) installed.push(f);
  }
  document.body.removeChild(span);
  o.fonts = installed;
  o.fontCount = installed.length;

  // ── canvas 2d ──
  try {
    const c = document.createElement('canvas'); c.width=240; c.height=60;
    const x = c.getContext('2d');
    x.textBaseline='top'; x.font='16px Arial'; x.fillStyle='#f60'; x.fillRect(1,1,80,30);
    x.fillStyle='#069'; x.fillText('VGC \\u{1F600} correlation',2,2);
    x.strokeStyle='rgba(0,120,200,0.7)'; x.beginPath(); x.arc(120,30,20,0,7); x.stroke();
    o.canvas = c.toDataURL().slice(-48);
  } catch(e){ o.canvas='ERR'; }

  // ── webgl ──
  try {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2') || c.getContext('webgl');
    const e = g.getExtension('WEBGL_debug_renderer_info');
    o.webglRenderer = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
    o.webglVendor = e ? g.getParameter(e.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR);
    // a tiny render hash
    g.clearColor(0.2,0.4,0.6,1); g.clear(g.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4); g.readPixels(0,0,1,1,g.RGBA,g.UNSIGNED_BYTE,px);
    o.webglPixel = Array.from(px).join(',');
    o.webglParams = [g.getParameter(g.MAX_TEXTURE_SIZE), g.getParameter(g.MAX_RENDERBUFFER_SIZE), g.getParameter(g.MAX_VERTEX_ATTRIBS)].join('/');
  } catch(e){ o.webglRenderer='ERR:'+e; }

  // ── audio (OfflineAudioContext fingerprint) ──
  try {
    const ac = new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(1,44100,44100);
    const osc = ac.createOscillator(); osc.type='triangle'; osc.frequency.value=10000;
    const comp = ac.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ac.destination); osc.start(0);
    const buf = await ac.startRendering();
    const data = buf.getChannelData(0);
    let sum=0; for (let i=4000;i<5000;i++) sum += Math.abs(data[i]);
    o.audio = sum.toFixed(9);
    // a rounded-to-3dp version — what many real fingerprinters actually hash. If THIS is
    // identical across profiles, the audio noise is too weak to differentiate them.
    o.audioRounded = sum.toFixed(3);
  } catch(e){ o.audio='ERR:'+e; }

  // ── screen / hardware / misc ──
  o.screen = [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, devicePixelRatio].join('x');
  o.cores = n.hardwareConcurrency;
  o.mem = n.deviceMemory;
  o.platform = n.platform;
  o.langs = (n.languages||[]).join(',');
  o.ua = n.userAgent;
  try { const h = await n.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','uaFullVersion','model']); o.uach = [h.architecture,h.bitness,h.platformVersion,h.uaFullVersion].join('|'); } catch(e){ o.uach='ERR'; }
  try { o.conn = [n.connection.effectiveType, n.connection.rtt, n.connection.downlink].join(','); } catch(e){ o.conn='none'; }
  o.plugins = Array.prototype.map.call(n.plugins,p=>p.name).join(',');
  o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  o.maxTouch = n.maxTouchPoints;

  // ── client rects ──
  try { const r = document.body.getBoundingClientRect(); o.rects = [r.width, r.height].join(','); } catch(e){ o.rects='ERR'; }

  // getBoundingClientRect vs getClientRects CONSISTENCY (the old JS half-measure farbled
  // only getBoundingClientRect → the two disagreed = a tell). Native farbling should make
  // them match. Also window-vs-worker connection consistency is checked via o.worker above.
  try {
    const sp2 = document.createElement('span'); sp2.textContent = 'vgc rect consistency probe';
    sp2.style.cssText = 'position:absolute;left:5.5px;top:7.5px;font-size:20px';
    document.body.appendChild(sp2);
    const list = sp2.getClientRects();
    const b = sp2.getBoundingClientRect(), cr = list[0];
    o.rectConsistent = (b.width === cr.width && b.height === cr.height && b.x === cr.x && b.y === cr.y);
    o.rectDbg = 'n=' + list.length + ' b=[' + [b.x,b.y,b.width,b.height].map(v=>v.toFixed(4)).join(',') + '] cr0=[' + [cr.x,cr.y,cr.width,cr.height].map(v=>v.toFixed(4)).join(',') + ']';
    document.body.removeChild(sp2);
  } catch(e){ o.rectConsistent = 'ERR:' + e; }

  // ── speechSynthesis voices (OS TTS voices — a classic same-machine correlator) ──
  try {
    let voices = speechSynthesis.getVoices();
    if (!voices.length) { await new Promise(r=>setTimeout(r,600)); voices = speechSynthesis.getVoices(); }
    o.voices = voices.map(v=>v.name+':'+v.lang).join('|');
    o.voiceCount = voices.length;
  } catch(e){ o.voices='ERR'; }

  // ── webgl extensions + precision + max params (GPU-tied; spoofing the renderer STRING
  //    doesn't change these, so they reveal the real GPU class across profiles) ──
  try {
    const c=document.createElement('canvas'); const g=c.getContext('webgl2')||c.getContext('webgl');
    o.webglExt = (g.getSupportedExtensions()||[]).join(',').slice(0,120);
    const hp = g.getShaderPrecisionFormat(g.FRAGMENT_SHADER, g.HIGH_FLOAT);
    o.webglPrecision = hp ? (hp.precision+'/'+hp.rangeMin+'/'+hp.rangeMax) : 'n';
    o.webglMax = [g.getParameter(g.MAX_VIEWPORT_DIMS)?.join('x'), g.getParameter(g.MAX_TEXTURE_IMAGE_UNITS), g.getParameter(g.ALIASED_LINE_WIDTH_RANGE)?.join('-')].join('|');
  } catch(e){ o.webglExt='ERR'; }

  // ── audio context metadata (sampleRate / channels — often machine-constant) ──
  try {
    const ac=new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(1,128,44100);
    o.audioMeta=[ac.sampleRate, ac.destination.maxChannelCount, ac.destination.channelCount].join(',');
  } catch(e){ o.audioMeta='ERR'; }

  // ── mediaDevices count ──
  try { const d = await navigator.mediaDevices.enumerateDevices(); o.mediaCount = d.length + ':' + d.map(x=>x.kind).join(','); } catch(e){ o.mediaCount='ERR'; }

  // ── WORKER fingerprint (a Web Worker has its own WorkerNavigator; the JS guard/CDP
  //    overrides live in the page realm and CANNOT reach it, so if the ENGINE doesn't
  //    spoof workers natively, a worker leaks the REAL machine — same value across every
  //    profile = a same-machine correlator that page-level spoofing can't hide) ──
  o.worker = await new Promise((resolve) => {
    try {
      const src = 'self.onmessage=function(){var c=navigator.connection||{};self.postMessage([navigator.hardwareConcurrency,navigator.deviceMemory,navigator.platform,(navigator.languages||[]).join(","),c.effectiveType,c.rtt,c.downlink].join("|"))}';
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      const w = new Worker(url);
      const t = setTimeout(() => resolve('timeout'), 6000);
      w.onmessage = (e) => { clearTimeout(t); resolve(e.data); try { w.terminate(); } catch(_){} };
      w.onerror = (e) => { clearTimeout(t); resolve('WORKER-ERR:' + (e && e.message ? e.message : e)); };
      w.postMessage(1);
    } catch(e){ resolve('ERR:' + e); }
  });

  // ── WebRTC ICE candidates (the classic physical-machine leak: a LAN IP like
  //    192.168.x ties every profile to one box regardless of proxy) ──
  o.webrtc = await new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.createDataChannel('x');
      const ips = {};
      pc.onicecandidate = (e) => {
        if (e && e.candidate) {
          const m = e.candidate.candidate.match(/((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|([a-f0-9]{1,4}:){3,}[a-f0-9:]+/i);
          if (m) ips[m[0]] = 1;
        }
      };
      pc.createOffer().then((d) => pc.setLocalDescription(d)).catch(() => {});
      setTimeout(() => { try { pc.close(); } catch(_){} resolve(Object.keys(ips).join(',') || 'none'); }, 3500);
    } catch(e){ resolve('ERR:' + e); }
  });

  return o;
})()`

interface Probe { [k: string]: unknown }

async function launchAndProbe(fp: Fingerprint, id: string, pageUrl: string): Promise<Probe> {
  const udd = mkdtempSync(join(tmpdir(), 'vgc-corr-'))
  const seed = seedFromString(id)
  const guardExt = ensureNativeGuardExtension(udd, fp)

  const langs = fp.languages && fp.languages.length ? fp.languages : [fp.language]
  const macArm = /apple/i.test(fp.webgl?.renderer || '')
  const args = [
    `--user-data-dir=${udd}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-crash-restore-bubble',
    ...(process.env.HEADFUL ? [] : ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    `--lang=${fp.language}`,
    `--window-size=${fp.screen.width},${fp.screen.height - 40}`,
    `--user-agent=${fp.userAgent}`,
    `--vgc-ua-full-version=${fp.uaFullVersion || ''}`,
    `--vgc-ua-platform=${UA_PLATFORM}`,
    `--vgc-ua-platform-version=${fp.uaPlatformVersion || '15.0.0'}`,
    `--vgc-ua-arch=${UA_ARCH}`,
    '--vgc-ua-bitness=64',
    `--vgc-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--vgc-device-memory=${fp.deviceMemory}`,
    `--vgc-platform=${fp.platform}`,
    `--vgc-webgl-vendor=${fp.webgl.vendor}`,
    `--vgc-webgl-renderer=${fp.webgl.renderer}`,
    `--vgc-timezone=${fp.timezone}`,
    `--vgc-accept-languages=${langs.join(',')}`,
    ...(fp.fonts && fp.fonts.length ? [`--vgc-fonts=${fp.fonts.join(',')}`] : []),
    `--vgc-screen=${fp.screen.width}x${fp.screen.height}`,
    `--vgc-color-depth=${fp.screen.colorDepth}`,
    `--vgc-seed=${seed}`,
    `--vgc-profile-name=${id}`,
    ...(guardExt ? [`--load-extension=${guardExt}`, `--disable-extensions-except=${guardExt}`] : []),
    'about:blank'
  ]
  void macArm
  const browser = await openNativePage(ENGINE, args, pageUrl)
  try {
    return (await evaluate(browser.conn, browser.sessionId, PROBE)) as Probe
  } finally {
    await browser.close()
    rmSync(udd, { recursive: true, force: true })
  }
}

// Real host specs, so the audit can flag any signal that LEAKS the physical machine
// (a value equal to the host's true cores / RAM / LAN IP). Override via env for other hosts.
const REAL_CORES = process.env.REAL_CORES || ''
const REAL_MEM = process.env.REAL_MEM || ''
const REAL_LAN = (process.env.REAL_LAN || '').split(',').filter(Boolean)

function leaksMachine(value: string): string | null {
  const v = String(value)
  for (const ip of REAL_LAN) if (ip && v.includes(ip)) return `LAN IP ${ip}`
  // a bare private-range IP anywhere is a physical-machine leak
  const priv = v.match(/\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/)
  if (priv) return `private IP ${priv[0]}`
  if (REAL_CORES && new RegExp(`(^|\\|)${REAL_CORES}(\\||$)`).test(v)) return `real cores ${REAL_CORES}`
  if (REAL_MEM && new RegExp(`(^|\\|)${REAL_MEM}(\\||$)`).test(v)) return `real RAM ${REAL_MEM}`
  return null
}

async function main(): Promise<void> {
  console.log('engine:', ENGINE)
  console.log(`real host: ${REAL_CORES || '?'} cores / ${REAL_MEM || '?'} GB / LAN ${REAL_LAN.join(',') || '?'}`)
  const N = 3
  const fps = Array.from({ length: N }, () => generateFingerprint(OS as Parameters<typeof generateFingerprint>[0]))
  fps.forEach((f, i) =>
    console.log(`profile ${i}: ${f.hardwareConcurrency}c/${f.deviceMemory}GB ${f.webgl.renderer.slice(0, 42)}`)
  )
  const probes: Probe[] = []
  const page = await createLoopbackPage()
  try {
    for (let i = 0; i < N; i++) {
      probes.push(await launchAndProbe(fps[i], `corr-profile-${i}-xyz`, page.url))
    }
  } finally {
    await page.close()
  }

  const keys = Array.from(new Set(probes.flatMap((p) => Object.keys(p))))
  const correlators: string[] = []
  const good: string[] = []
  const leaks: string[] = []
  const show = (v: string): string => (v && v.length > 76 ? v.slice(0, 76) + '…' : v)

  console.log(`\n===== ${N}-PROFILE COMPARISON =====`)
  for (const k of keys) {
    const vals = probes.map((p) => JSON.stringify(p[k]))
    const allSame = vals.every((v) => v === vals[0])
    // machine leak: ANY profile exposing a real-host value
    for (let i = 0; i < N; i++) {
      const why = leaksMachine(vals[i])
      if (why) { leaks.push(`${k} (profile ${i}: ${why})`); break }
    }
    if (allSame) correlators.push(k)
    else good.push(k)
    console.log(`${allSame ? 'SAME ⚠️ ' : 'diff ok'}  ${k}`)
    if (allSame) console.log(`         all = ${show(vals[0])}`)
    else vals.forEach((v, i) => console.log(`         [${i}] ${show(v)}`))
  }

  // fonts overlap across all 3
  const fsets = probes.map((p) => (p.fonts as string[]) || [])
  const sharedFonts = fsets[0].filter((f) => fsets.every((s) => s.includes(f)))

  console.log('\n===== VERDICT =====')
  console.log(`fonts per profile: ${fsets.map((s) => s.length).join(', ')} ; shared by all 3: ${sharedFonts.length}`)
  // Worker: is it leaking the real machine? (same across profiles AND == real host)
  console.log(`worker readback (cores|mem|plat|langs|et|rtt|dl): ${probes.map((p) => p.worker).join('  ||  ')}`)
  console.log(`webrtc IPs:      ${probes.map((p) => p.webrtc).join('  ||  ')}`)
  const rc = probes.map((p) => p.rectConsistent)
  console.log(
    `getBoundingClientRect == getClientRects: ${JSON.stringify(rc)} ${rc.every((x) => x === true) ? '🟢' : '🔴 MISMATCH tell'}`
  )

  const DANGER = ['fonts', 'canvas', 'audio', 'webglRenderer', 'webglPixel', 'screen', 'voices', 'worker']
  const hits = DANGER.filter((d) => correlators.includes(d))

  console.log('\n===== FINAL =====')
  console.log(`IDENTICAL across all ${N} (potential correlators): ${correlators.join(', ')}`)
  if (leaks.length) {
    console.log(`\n🔴 PHYSICAL-MACHINE LEAKS (${leaks.length}):`)
    leaks.forEach((l) => console.log(`   - ${l}`))
  } else {
    console.log(`\n🟢 no physical-machine leak (no real cores/RAM/LAN IP exposed)`)
  }
  console.log(
    hits.length
      ? `🔴 HIGH-SIGNAL same-machine correlators: ${hits.join(', ')}`
      : `🟢 no high-signal same-machine correlator (fonts/canvas/audio/webgl/screen/voices/worker all differ)`
  )
  process.exitCode = leaks.length || hits.length ? 1 : 0
}

main().catch((e) => {
  console.error('correlation test error:', e)
  process.exitCode = 2
})
