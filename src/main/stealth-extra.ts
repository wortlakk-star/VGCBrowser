// ── VGC Browser — extra stealth spoofs (shared: CDP-mode ⇄ native-guard) ──────
// The vectors here are JS-observable fingerprint surfaces that are NOT yet spoofed
// by the VGC Core C++ engine, so BOTH injection surfaces need them:
//   • fingerprint-script.ts  (CDP mode — nativeMode OFF)
//   • webrtc-guard.ts        (native mode — the DEFAULT path, MV3 guard extension)
//
// Covered:
//   1. Client rects   — getBoundingClientRect (Element + Range) sub-pixel farbling, returning
//                        a REAL DOMRect. `clientRectsNoise` was declared in the Fingerprint
//                        type but had NO implementation anywhere (dead flag). getClientRects is
//                        left native (JS DOMRectList isn't constructable); patch 07 does it in C++.
//   2. Screen offsets — screen.availLeft / availTop forced to 0 (a nonzero value leaks a
//                        secondary monitor's placement → ties every profile to one rig).
//   3. connection     — navigator.connection normalised to stable, privacy-rounded values
//                        (Chrome exposes effectiveType/rtt/downlink; a per-session-varying
//                        real link is a weak cross-profile correlator).
//   4. mediaDevices   — the mic/cam LABEL is blanked at the MediaDeviceInfo.prototype level
//                        (the real same-machine correlator across "different" accounts). Real
//                        objects/ids are kept intact so instanceof, getCapabilities() and
//                        getUserMedia({deviceId:{exact}}) selection all keep working.
//
// The body is plain JS (no template ${}) and is FULLY SELF-CONTAINED: it defines its
// own toString-masking (xmask/xdef) that CHAINS to whatever Function.prototype.toString
// the host surface already installed, so both the host's masks and ours keep reporting
// "[native code]". It must be self-contained because the host's mask()/def() are declared
// as function declarations inside a `try {}` block under "use strict" — which block-scopes
// them, so they are NOT visible to code appended after that block. (Relying on them made
// every override here throw silently.) Only XCFG is interpolated; everything is wrapped in
// try/catch so it can never throw into the page.

// CAPTCHA challenge frames (Cloudflare Turnstile → challenges.cloudflare.com, hCaptcha) run
// their OWN integrity checks and are extremely sensitive to page-script tampering — an injected
// getter/Proxy that throws (or even just LOOKS wrong) inside the challenge iframe makes the widget
// fail to load: "Lỗi cổng xoay 600010 — Captcha không tải được". So the JS guard BAILS OUT the moment
// it finds itself running inside such a frame (a bare `return` from the wrapping IIFE). It costs
// nothing: the VGC Core ENGINE spoofs (screen/UA-CH/canvas/webgl/audio/fonts/timezone/connection/
// client-rects/deviceMemory/cores) are C++ and STILL apply inside the iframe, so the challenge sees a
// perfectly consistent, normal Chrome — just without the extra JS overrides that were breaking it.
// Prepended to BOTH injected bodies (native guard + CDP), so it must be self-contained (no helpers).
// String-compare only (no regex) to keep template-literal embedding trivial. '.hcaptcha.com' = 13 chars.
export const CAPTCHA_FRAME_BAILOUT =
  "try{var _vh=(self.location&&self.location.hostname)||'';" +
  "if(_vh==='challenges.cloudflare.com'||_vh==='hcaptcha.com'||_vh.slice(-13)==='.hcaptcha.com'){return;}}catch(_e){}"

export interface ExtraSpoofCfg {
  /** Per-profile noise seed (FNV-1a of the profile id) — same value the engine gets
   *  via --vgc-seed, so JS-mode and native-mode noise are derived identically. */
  seed: number
  /** Gate for the client-rects farbling (the profile's fingerprint.clientRectsNoise). */
  clientRectsNoise: boolean
  /** The profile's navigator.deviceMemory (GB). Used to keep performance.memory's
   *  jsHeapSizeLimit coherent with the claimed RAM class (see the memory block below). */
  deviceMemory: number
}

export function extraSpoofBody(cfg: ExtraSpoofCfg): string {
  const xcfg = {
    seed: cfg.seed >>> 0,
    clientRects: cfg.clientRectsNoise === true,
    deviceMemory: cfg.deviceMemory > 0 ? cfg.deviceMemory : 8
  }
  return 'var XCFG=' + JSON.stringify(xcfg) + ';' + EXTRA_BODY
}

const EXTRA_BODY = `
try {
  // ── Native-identity masking (same technique as fingerprint-script.ts) ──────
  // Each override is a Proxy over the ORIGINAL native function, so toString(), name,
  // length, the absence of an own .prototype and non-constructability all resolve against
  // the native target — including from another realm (an iframe's Function.prototype.
  // toString previously bypassed the per-realm WeakMap and printed our source). Nothing
  // patches Function.prototype.toString any more; that patch was itself a plain function
  // expression and therefore a tell.
  function xnat(orig, impl){
    try {
      if (typeof orig !== 'function') return impl;
      return new Proxy(orig, { apply: function(t, self, a){ return impl.apply(self, a); } });
    } catch(e){ return impl; }
  }
  // Redefines an EXISTING accessor only, reusing the native getter as the proxy target and
  // preserving the native descriptor attributes.
  function xdef(obj, prop, getter){
    try {
      var d = Object.getOwnPropertyDescriptor(obj, prop);
      if (!d || !d.get) return;
      Object.defineProperty(obj, prop, { get: xnat(d.get, getter), set: d.set, configurable: d.configurable, enumerable: d.enumerable });
    } catch(e){}
  }

  // Local PRNG so this block is self-contained (does not depend on the host's mulberry32).
  function xmul(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

  // ── 1. Client rects farbling (getBoundingClientRect only) ─────────────────
  // clientRects fingerprinting hashes the sub-pixel box geometry of rendered text. We add a
  // deterministic, per-metric sub-pixel offset:
  //   • deterministic  → the SAME element+metric always yields the SAME delta, so a
  //                       double-read returns identical rects (unstable = "spoofed" tell).
  //   • per-value      → different coordinates get different deltas, so RATIOS between
  //                       rects change too — defeats ratio-normalised hashes, not just
  //                       absolute ones.
  //   • ~±0.0001 px    → far below any real layout effect (invisible), but shifts the
  //                       float hash creepjs / pixelscan compute.
  // xrect returns a REAL DOMRect (correct prototype, instanceof/toStringTag intact), so there
  // is no wrong-type tell. getClientRects() is deliberately LEFT NATIVE: a JS DOMRectList is
  // not constructable, and returning a plain Array is a stronger '[object Array]' tell than the
  // farbling is worth — the native patch 07-client-rects-native.patch farbles getClientRects at
  // the C++ level (real DOMRectList) once the engine is rebuilt.
  // The VGC Core ENGINE farbles getClientRects + getBoundingClientRect natively (element.cc,
  // UNION approach: getBoundingClientRect == union(getClientRects), and a DETACHED element stays
  // all-zero exactly like stock Chrome — no invariant broken, so it must NOT be used as a probe).
  // When the engine is present we MUST skip this JS override: it only touches getBoundingClientRect,
  // so on top of the native farble it yields getBoundingClientRect != getClientRects — the exact
  // bcr!=cr tell (confirmed [false,false,false] in verify:correlation when this ran). The reliable
  // "VGC engine present" signal is __vgcScreenNative (screen.cc spoofed screen.width, read from the
  // RAW value before any JS screen getter). It exists ONLY in the native guard; in CDP mode it is
  // undefined and the engine still farbles natively (switches are always forwarded) so we skip there
  // too. JS runs ONLY on the system-Chrome fallback (engine blocked → screen NOT native).
  if (XCFG.clientRects && typeof __vgcScreenNative !== 'undefined' && !__vgcScreenNative) {
    try {
      function xrn(v, salt){
        var s = (XCFG.seed ^ (salt>>>0) ^ ((Math.round(v*1000))>>>0)) >>> 0;
        s ^= s>>>15; s = Math.imul(s, 0x2C1B3C6D)>>>0; s ^= s>>>12; s = Math.imul(s, 0x297A2D39)>>>0; s ^= s>>>15;
        return v + (((s & 0xffff)/0xffff) - 0.5) * 0.0002;
      }
      function xrect(r){
        try {
          var x = xrn(r.x, 0x1001), y = xrn(r.y, 0x2002), w = xrn(r.width, 0x3003), h = xrn(r.height, 0x4004);
          if (window.DOMRect) return new DOMRect(x, y, w, h);
          return { x:x, y:y, width:w, height:h, top:y, right:x+w, bottom:y+h, left:x, toJSON:function(){ return { x:x, y:y, width:w, height:h, top:y, right:x+w, bottom:y+h, left:x }; } };
        } catch(e){ return r; }
      }
      var _gbcr = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = xnat(_gbcr, function(){ return xrect(_gbcr.apply(this, arguments)); });
      if (window.Range) {
        var _rr = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = xnat(_rr, function(){ return xrect(_rr.apply(this, arguments)); });
      }
    } catch(e){}
  }

  // ── 2. Screen avail offsets ───────────────────────────────────────────────
  // A nonzero availLeft/availTop is the tell of a multi-monitor rig (the browser sitting
  // on a secondary display). Force the primary-monitor value 0 so every profile looks like
  // a single-display machine and no two profiles share the same odd offset.
  // The VGC Core ENGINE (screen.cc) ALREADY returns availLeft/availTop = 0 natively when
  // --vgc-screen is set — so wrapping the JS getter on top is pure redundancy that only ADDS a
  // tell: the xdef Proxy makes the getter's toString anonymous ("function () { [native code] }"
  // instead of "function get availLeft() { [native code] }"). Gate on __vgcScreenNative (same as
  // client-rects/connection): run the JS override ONLY on the system-Chrome fallback where the
  // engine is absent; on the native engine (and in CDP, where it is undefined) leave the native
  // getter untouched — pure native, no name tell.
  try {
    if (typeof __vgcScreenNative !== 'undefined' && !__vgcScreenNative) {
      xdef(Screen.prototype, 'availLeft', function(){ return 0; });
      xdef(Screen.prototype, 'availTop', function(){ return 0; });
    }
  } catch(e){}

  // ── 2b. performance.memory.jsHeapSizeLimit ────────────────────────────────
  // Chrome's V8 heap limit scales with PHYSICAL RAM, not with navigator.deviceMemory:
  // an 8GB+ machine reports 4,395,630,592 (~4.09 GB) while a 4GB machine reports
  // 2,172,649,472 (~2.02 GB). We spoof deviceMemory (capped at 8) but left jsHeapSizeLimit
  // at the host's real value — so a profile claiming deviceMemory:4 on a big rig exposed a
  // 4.4GB heap limit, an internal contradiction creepjs/pixelscan flag ("device 4GB but V8
  // heap says ≥8GB"). Pin jsHeapSizeLimit to the canonical value for the claimed RAM class.
  // Only jsHeapSizeLimit is touched: used/total are page-runtime values that leak nothing
  // about hardware and fluctuate naturally, so faking them (constant) would be the bigger tell.
  try {
    if (window.performance && performance.memory && typeof performance.memory.jsHeapSizeLimit === 'number') {
      var _mproto = Object.getPrototypeOf(performance.memory);
      var _dm = XCFG.deviceMemory;
      var _limit = _dm <= 2 ? 1090519040 : (_dm <= 4 ? 2172649472 : 4395630592);
      // Match the host: never claim a HIGHER limit than the machine actually has (that
      // would be impossible), only cap it down to stay coherent with the small-RAM claim.
      if (_limit < performance.memory.jsHeapSizeLimit) {
        xdef(_mproto, 'jsHeapSizeLimit', function(){ return _limit; });
      }
    }
  } catch(e){}

  // ── 3. navigator.connection ───────────────────────────────────────────────
  // Chrome exposes NetworkInformation (effectiveType/rtt/downlink/saveData). rtt/downlink
  // are already privacy-rounded by Chrome but still vary with the real link per session —
  // a weak correlator. Pin them to stable, plausible broadband values (rtt seeded per
  // profile so they are not all identical). downlink is capped at 10 like real Chrome.
  // Skip when the VGC Core engine spoofs navigator.connection natively (network_information.cc,
  // which covers window AND workers consistently) — a JS override here would only touch the
  // window, so the worker's rtt/downlink would disagree (a window/worker mismatch tell). Same gate
  // as client-rects: skip whenever the engine is present (__vgcScreenNative true, OR CDP where it
  // is undefined and the switches are still forwarded); run ONLY on the system-Chrome fallback.
  try {
    var _conn = (typeof __vgcScreenNative !== 'undefined' && !__vgcScreenNative)
      ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection)
      : null;
    if (_conn) {
      var NI = Object.getPrototypeOf(_conn);
      var _cr = xmul((XCFG.seed ^ 0x27D4EB2F) >>> 0);
      // Wider seeded range so two profiles rarely collide (the old 3-value range made
      // rtt=50 identical across profiles ~1/9 of the time — itself a correlator). All
      // values stay in Chrome's rounded, plausible broadband range.
      var _rtt = 25 + (((_cr() * 8) | 0) * 25);           // 25..200 step 25
      var _dl = [10, 9, 8.5, 7.5, 6.5, 5.5, 4.5][(_cr() * 7) | 0]; // seeded downlink (Chrome caps at 10)
      xdef(NI, 'effectiveType', function(){ return '4g'; });
      xdef(NI, 'rtt', function(){ return _rtt; });
      xdef(NI, 'downlink', function(){ return _dl; });
      xdef(NI, 'saveData', function(){ return false; });
    }
  } catch(e){}

  // ── 3b. speechSynthesis voices ────────────────────────────────────────────
  // The OS TTS voice list (e.g. "Microsoft David/Mark/Zira") is identical across every
  // profile on a machine → a same-machine correlator. Expose a per-seed SUBSET so the
  // list differs per profile, keeping the decision DETERMINISTIC per voice index (so
  // repeated getVoices() calls are stable — an unstable list is itself a tell) and always
  // keeping at least the first voice (an empty list is a tell too).
  try {
    if (window.SpeechSynthesis && SpeechSynthesis.prototype && SpeechSynthesis.prototype.getVoices) {
      var _keepVoice = function(i){
        var s = (XCFG.seed ^ 0x5F356495 ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0;
        s ^= s >>> 15; s = Math.imul(s, 0x2C1B3C6D) >>> 0; s ^= s >>> 13;
        return (s & 3) !== 0; // keep ~75% of the non-primary voices
      };
      var _gv = SpeechSynthesis.prototype.getVoices;
      SpeechSynthesis.prototype.getVoices = xnat(_gv, function(){
        var list = _gv.call(this);
        try {
          if (!list || list.length <= 1) return list;
          var keep = [];
          for (var i = 0; i < list.length; i++) { if (i === 0 || _keepVoice(i)) keep.push(list[i]); }
          return keep.length ? keep : [list[0]];
        } catch(e){ return list; }
      });
    }
  } catch(e){}

  // ── 4. mediaDevices labels ────────────────────────────────────────────────
  // The real cross-machine correlator is the LABEL ("HD Pro Webcam C920", "Realtek Audio") —
  // identical across every profile on a host. deviceId/groupId are ALREADY per-profile salted
  // by Chrome (each profile has its own user-data-dir), so they are NOT a cross-profile tell,
  // and rewriting them only broke getUserMedia({deviceId:{exact}}) selection. So we blank ONLY
  // the label, at the PROTOTYPE level — keeping the REAL MediaDeviceInfo/InputDeviceInfo objects
  // (instanceof, getCapabilities(), and an empty Object.keys all survive; no plain-object tell).
  // toJSON is overridden too because MediaDeviceInfo.toJSON() serialises the label from the
  // internal slot, bypassing the getter — without this, JSON.stringify(device) would re-leak it.
  try {
    var _MDI = window.MediaDeviceInfo;
    if (_MDI && _MDI.prototype) {
      xdef(_MDI.prototype, 'label', function(){ return ''; });
      if (_MDI.prototype.toJSON) {
        var _origToJSON = _MDI.prototype.toJSON;
        Object.defineProperty(_MDI.prototype, 'toJSON', {
          configurable: true, enumerable: true, writable: true,
          value: xnat(_origToJSON, function(){ return { deviceId: this.deviceId, kind: this.kind, label: '', groupId: this.groupId }; })
        });
      }
    }
  } catch(e){}
} catch(e){ /* never throw into the page */ }
`
