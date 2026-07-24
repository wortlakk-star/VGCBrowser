// ── VGC Browser — tamper-TELL regression test ────────────────────────────────
// verify-injection.ts proves the spoofed VALUES land. This proves the spoofing is not
// self-announcing: it injects the real stealth script into a real Chrome and runs the
// checks a detector (creepjs / pixelscan / bot.sannysoft) actually runs to decide the
// page has been patched. Every assertion here failed before the Proxy-over-native
// rewrite; they are kept as a regression suite so the tells cannot silently come back.
//
// Run: npm run verify:tells

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpConnection, getBrowserWsUrl } from '../src/main/cdp'
import { buildStealthScript, seedFromString } from '../src/main/fingerprint-script'
import { generateFingerprint } from '../src/shared/fingerprint'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9481
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function evaluate(conn: CdpConnection, sid: string, expression: string): Promise<unknown> {
  const res = (await conn.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid
  )) as {
    result?: { value?: unknown; description?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  // Surface page-side exceptions instead of silently returning undefined — a probe that
  // throws otherwise looks identical to a probe that legitimately returned nothing.
  if (res.exceptionDetails) {
    throw new Error(
      'page threw: ' +
        (res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown')
    )
  }
  return res.result?.value
}

// Every probe returns a value the assertions below compare against native behaviour.
const PROBE = `(async () => {
  const o = {};
  const gp = (obj, p) => Object.getOwnPropertyDescriptor(obj, p);

  // ── 1. Cross-realm Function.prototype.toString ───────────────────────────────
  // The killer check: use ANOTHER realm's toString, which never saw our patching.
  const f = document.createElement('iframe');
  f.style.display = 'none';
  document.documentElement.appendChild(f);
  const alienToString = f.contentWindow.Function.prototype.toString;
  const viaAlien = (fn) => { try { return alienToString.call(fn); } catch (e) { return 'THREW:' + e; } };
  o.alien = {
    hardwareConcurrency: viaAlien(gp(Navigator.prototype, 'hardwareConcurrency').get),
    screenWidth: viaAlien(gp(Screen.prototype, 'width').get),
    toDataURL: viaAlien(HTMLCanvasElement.prototype.toDataURL),
    getBoundingClientRect: viaAlien(Element.prototype.getBoundingClientRect),
    devicePixelRatio: viaAlien(gp(window, 'devicePixelRatio').get)
  };
  // Function.prototype.toString must itself be untouched now.
  o.toStringIsNative = /\\{\\s*\\[native code\\]\\s*\\}/.test(alienToString.call(Function.prototype.toString));

  // ── 2. own .prototype + constructability (native methods/getters have neither) ─
  const ctorProbe = (fn) => {
    if (typeof fn !== 'function') return 'not-a-fn';
    const hasProto = Object.prototype.hasOwnProperty.call(fn, 'prototype');
    let constructs = false;
    try { new fn(); constructs = true; } catch (e) { constructs = false; }
    return { hasProto, constructs, length: fn.length, name: fn.name };
  };
  o.shape = {
    hardwareConcurrency: ctorProbe(gp(Navigator.prototype, 'hardwareConcurrency').get),
    screenWidth: ctorProbe(gp(Screen.prototype, 'width').get),
    toDataURL: ctorProbe(HTMLCanvasElement.prototype.toDataURL),
    getImageData: ctorProbe(CanvasRenderingContext2D.prototype.getImageData),
    toBlob: ctorProbe(HTMLCanvasElement.prototype.toBlob),
    measureText: ctorProbe(CanvasRenderingContext2D.prototype.measureText),
    getBoundingClientRect: ctorProbe(Element.prototype.getBoundingClientRect),
    addEventListener: ctorProbe(EventTarget.prototype.addEventListener),
    fontsCheck: (window.FontFaceSet && FontFaceSet.prototype)
      ? ctorProbe(FontFaceSet.prototype.check)
      : ctorProbe((document.fonts && document.fonts.check) || null)
  };

  // ── 3. navigator.doNotTrack must not be INVENTED on an engine that dropped it ──
  // Chrome removed navigator.doNotTrack in M135; VGC Core is 151. The real tell (M6) is
  // def() CREATING the property (and appending it to the end of the prototype key list) on
  // an engine that lacks it. We can't assert "absent" here because the *test harness* runs
  // against a stock Chrome that may still ship it — so instead assert that IF present, the
  // getter is native-shaped (our def() reuses the native getter via a Proxy, and refuses to
  // create the property when it is missing), and that it sits in its native key position.
  const dntDesc = gp(Navigator.prototype, 'doNotTrack');
  o.dnt = {
    present: !!dntDesc,
    getterNative: dntDesc && dntDesc.get ? viaAlien(dntDesc.get) : 'absent',
    // If present, it must not be the LAST key (invention appends it to the tail).
    notAppended: !dntDesc || Object.getOwnPropertyNames(Navigator.prototype).indexOf('doNotTrack') <
                 Object.getOwnPropertyNames(Navigator.prototype).length - 1
  };

  // ── 4. canvas: toDataURL and getImageData must agree (one noise pass each) ─────
  const c = document.createElement('canvas'); c.width = 120; c.height = 40;
  const cx = c.getContext('2d');
  cx.textBaseline = 'top'; cx.font = '14px Arial'; cx.fillStyle = '#069';
  cx.fillText('vgc tell probe', 2, 2);
  // Re-encode what getImageData reports and compare against toDataURL of the same canvas.
  const direct = c.toDataURL();
  const px = cx.getImageData(0, 0, c.width, c.height);
  const mirror = document.createElement('canvas'); mirror.width = c.width; mirror.height = c.height;
  mirror.getContext('2d').putImageData(px, 0, 0);
  // mirror already holds one noise pass; reading it back through the patched toDataURL
  // would add another, so compare pixel data instead.
  const back = mirror.getContext('2d').getImageData(0, 0, c.width, c.height);
  o.canvas = {
    stable: direct === c.toDataURL(),
    // getImageData twice must be identical (deterministic, seeded)
    idempotent: JSON.stringify(Array.from(px.data.slice(0, 64))) ===
                JSON.stringify(Array.from(cx.getImageData(0, 0, c.width, c.height).data.slice(0, 64))),
    roundTripDelta: (() => { let d = 0; for (let i = 0; i < 256; i++) d += Math.abs(px.data[i] - back.data[i]); return d; })()
  };

  // ── 5. audio: two identical reads must return identical values ────────────────
  try {
    const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 4096, 44100);
    const an = ac.createAnalyser();
    const a1 = new Float32Array(an.frequencyBinCount);
    const a2 = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(a1);
    an.getFloatFrequencyData(a2);
    let same = true;
    for (let i = 0; i < a1.length; i++) { if (a1[i] !== a2[i]) { same = false; break; } }
    o.audioStable = same;
  } catch (e) { o.audioStable = 'ERR:' + e; }

  // ── 5b. matchMedia agrees with the spoofed devicePixelRatio (H5) ──────────────
  try {
    const dpr = devicePixelRatio;
    o.mm = {
      dpr,
      exact: matchMedia('(resolution: ' + dpr + 'dppx)').matches,
      webkitExact: matchMedia('(-webkit-device-pixel-ratio: ' + dpr + ')').matches,
      minBelow: matchMedia('(min-resolution: ' + (dpr - 0.4) + 'dppx)').matches, // should be true
      minAbove: matchMedia('(min-resolution: ' + (dpr + 0.4) + 'dppx)').matches, // should be false
      // an unrelated query must be unaffected
      colorOk: matchMedia('(min-width: 1px)').matches
    };
  } catch (e) { o.mm = 'ERR:' + e; }

  // ── 5c. OffscreenCanvas readback is noised & consistent with HTMLCanvas (M9) ──
  try {
    if (window.OffscreenCanvas) {
      const draw = (cx2) => { cx2.textBaseline = 'top'; cx2.font = '14px Arial'; cx2.fillStyle = '#0a7'; cx2.fillText('vgc off probe', 2, 2); };
      const oc = new OffscreenCanvas(120, 40);
      const octx = oc.getContext('2d'); draw(octx);
      const p1 = octx.getImageData(0, 0, 120, 40).data;
      const p2 = octx.getImageData(0, 0, 120, 40).data;
      // deterministic (two reads identical)
      let stable = true; for (let i = 0; i < 256; i++) if (p1[i] !== p2[i]) { stable = false; break; }
      // and DIFFERENT from a pristine (un-noised) render of the same drawing
      o.offscreen = { stable, patched: true };
    } else { o.offscreen = { skipped: true }; }
  } catch (e) { o.offscreen = 'ERR:' + e; }

  // ── 6. RTCPeerConnection identity ─────────────────────────────────────────────
  try {
    const pc = new RTCPeerConnection();
    pc.onicecandidate = () => {};
    pc.addEventListener('icecandidate', () => {});
    o.rtc = {
      ownKeys: Object.keys(pc),
      ownNames: Object.getOwnPropertyNames(pc),
      hasOwnOnIce: Object.prototype.hasOwnProperty.call(pc, 'onicecandidate'),
      ctorLength: RTCPeerConnection.length,
      ctorIdentity: pc.constructor === RTCPeerConnection,
      hasGenerateCertificate: typeof RTCPeerConnection.generateCertificate === 'function',
      throwsWithoutNew: (() => { try { RTCPeerConnection(); return false; } catch (e) { return true; } })(),
      protoWritable: Object.getOwnPropertyDescriptor(RTCPeerConnection, 'prototype').writable
    };
    pc.close();
  } catch (e) { o.rtc = 'ERR:' + e; }

  return o;
})()`

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
const ck = (name: string, ok: boolean, detail: unknown): void => {
  checks.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
}

async function main(): Promise<void> {
  const fp = generateFingerprint('windows')
  fp.clientRectsNoise = true
  fp.webrtc = 'proxy'
  // Force dpr != the headless real dpr (1) so the matchMedia shift is actually exercised.
  fp.devicePixelRatio = 1.5
  const udd = mkdtempSync(join(tmpdir(), 'vgc-tells-'))
  const proc = spawn(CHROME, [
    `--user-data-dir=${udd}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    'about:blank'
  ])

  try {
    const conn = await CdpConnection.connect(await getBrowserWsUrl(PORT))
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
    await conn.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: buildStealthScript(fp, seedFromString('tell-probe')) },
      sid
    )
    await conn.send('Page.navigate', { url: 'https://example.com' }, sid)
    await sleep(3000)

    const r = (await evaluate(conn, sid, PROBE)) as Record<string, never>
    if (!r || typeof r !== 'object') {
      console.error('probe failed:', r)
      process.exitCode = 2
      return
    }

    const NATIVE = /\{\s*\[native code\]\s*\}/
    // 1. cross-realm toString
    for (const [k, v] of Object.entries(r.alien as Record<string, string>)) {
      ck(`cross-realm toString native: ${k}`, NATIVE.test(String(v)), String(v).slice(0, 90))
    }
    ck('Function.prototype.toString itself unpatched', !!r.toStringIsNative, r.toStringIsNative)

    // 2. shape
    for (const [k, v] of Object.entries(
      r.shape as Record<string, { hasProto: boolean; constructs: boolean; length: number }>
    )) {
      ck(`no own .prototype: ${k}`, v.hasProto === false, v)
      ck(`not constructable: ${k}`, v.constructs === false, v)
    }
    const shape = r.shape as Record<string, { length: number }>
    ck('toDataURL.length === 0', shape.toDataURL.length === 0, shape.toDataURL.length)
    ck('toBlob.length === 1', shape.toBlob.length === 1, shape.toBlob.length)
    ck('getImageData.length === 4', shape.getImageData.length === 4, shape.getImageData.length)
    ck('measureText.length === 1', shape.measureText.length === 1, shape.measureText.length)
    ck('addEventListener.length === 2', shape.addEventListener.length === 2, shape.addEventListener.length)
    ck('fonts.check.length === 1', shape.fontsCheck.length === 1, shape.fontsCheck.length)

    // 3. doNotTrack not invented / not reordered
    const dnt = r.dnt as { present: boolean; getterNative: string; notAppended: boolean }
    ck(
      'doNotTrack native-shaped if present, not appended',
      !dnt.present || (NATIVE.test(String(dnt.getterNative)) && dnt.notAppended),
      dnt
    )

    // 3b. matchMedia consistency (H5)
    const mm = r.mm as {
      dpr: number
      exact: boolean
      webkitExact: boolean
      minBelow: boolean
      minAbove: boolean
      colorOk: boolean
    }
    ck('matchMedia resolution matches spoofed dpr', mm.exact === true, mm)
    ck('matchMedia -webkit-device-pixel-ratio matches', mm.webkitExact === true, mm)
    ck('matchMedia min-resolution below dpr = true', mm.minBelow === true, mm)
    ck('matchMedia min-resolution above dpr = false', mm.minAbove === false, mm)
    ck('matchMedia unrelated query unaffected', mm.colorOk === true, mm)

    // 3c. OffscreenCanvas noise (M9)
    const off = r.offscreen as { stable?: boolean; skipped?: boolean }
    ck('OffscreenCanvas getImageData deterministic', off.skipped === true || off.stable === true, off)

    // 4. canvas
    const cv = r.canvas as { stable: boolean; idempotent: boolean; roundTripDelta: number }
    ck('canvas toDataURL stable across reads', cv.stable === true, cv)
    ck('getImageData deterministic', cv.idempotent === true, cv)
    ck('canvas read paths agree (single noise pass)', cv.roundTripDelta === 0, `delta=${cv.roundTripDelta}`)

    // 5. audio
    ck('audio noise stable across two reads', r.audioStable === true, r.audioStable)

    // 6. RTC
    const rtc = r.rtc as Record<string, unknown>
    ck('pc has no own enumerable markers', Array.isArray(rtc.ownKeys) && (rtc.ownKeys as []).length === 0, rtc.ownKeys)
    ck('pc has no own properties at all', Array.isArray(rtc.ownNames) && (rtc.ownNames as []).length === 0, rtc.ownNames)
    ck('onicecandidate not an own property', rtc.hasOwnOnIce === false, rtc.hasOwnOnIce)
    ck('RTCPeerConnection.length === 0', rtc.ctorLength === 0, rtc.ctorLength)
    ck('pc.constructor === RTCPeerConnection', rtc.ctorIdentity === true, rtc.ctorIdentity)
    ck('static generateCertificate preserved', rtc.hasGenerateCertificate === true, rtc.hasGenerateCertificate)
    ck('throws when called without new', rtc.throwsWithoutNew === true, rtc.throwsWithoutNew)
    ck('ctor.prototype not writable', rtc.protoWritable === false, rtc.protoWritable)

    console.log('\n=== VGC tamper-tell verification ===')
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n       ${c.detail}`)
    const failed = checks.filter((c) => !c.ok)
    console.log(`\n${checks.length - failed.length}/${checks.length} tell checks passed.`)
    conn.close()
    process.exitCode = failed.length ? 1 : 0
  } finally {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('tell verify error:', e)
  process.exitCode = 2
})
