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

export interface ExtraSpoofCfg {
  /** Per-profile noise seed (FNV-1a of the profile id) — same value the engine gets
   *  via --vgc-seed, so JS-mode and native-mode noise are derived identically. */
  seed: number
  /** Gate for the client-rects farbling (the profile's fingerprint.clientRectsNoise). */
  clientRectsNoise: boolean
}

export function extraSpoofBody(cfg: ExtraSpoofCfg): string {
  const xcfg = { seed: cfg.seed >>> 0, clientRects: cfg.clientRectsNoise === true }
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
  if (XCFG.clientRects) {
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
  try {
    xdef(Screen.prototype, 'availLeft', function(){ return 0; });
    xdef(Screen.prototype, 'availTop', function(){ return 0; });
  } catch(e){}

  // ── 3. navigator.connection ───────────────────────────────────────────────
  // Chrome exposes NetworkInformation (effectiveType/rtt/downlink/saveData). rtt/downlink
  // are already privacy-rounded by Chrome but still vary with the real link per session —
  // a weak correlator. Pin them to stable, plausible broadband values (rtt seeded per
  // profile so they are not all identical). downlink is capped at 10 like real Chrome.
  try {
    var _conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
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
