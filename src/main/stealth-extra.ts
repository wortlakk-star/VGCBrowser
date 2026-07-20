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
  // ── Self-contained toString masking (chains to the host's already-installed override) ──
  // xmask registers a patched fn so its .toString() reports native code; _xToString captures
  // whatever the host installed so the host's own masks still resolve through the chain.
  var _xToString = Function.prototype.toString;
  var _xNative = new WeakMap();
  function xmask(fn, name){ try{ _xNative.set(fn, 'function ' + name + '() { [native code] }'); Object.defineProperty(fn, 'name', { value: name, configurable: true }); }catch(e){} return fn; }
  var _xPatched = function toString(){ if(_xNative.has(this)) return _xNative.get(this); return _xToString.call(this); };
  try { Function.prototype.toString = xmask(_xPatched, 'toString'); } catch(e){}
  function xdef(obj, prop, getter){ try{ Object.defineProperty(obj, prop, { get: xmask(getter, 'get ' + prop), configurable:true, enumerable:true }); }catch(e){} }

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
      Element.prototype.getBoundingClientRect = xmask(function(){ return xrect(_gbcr.apply(this, arguments)); }, 'getBoundingClientRect');
      if (window.Range) {
        var _rr = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = xmask(function(){ return xrect(_rr.apply(this, arguments)); }, 'getBoundingClientRect');
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
      var _rtt = 50 + ((xmul((XCFG.seed ^ 0x27D4EB2F) >>> 0)() * 3) | 0) * 25; // 50 / 75 / 100
      xdef(NI, 'effectiveType', function(){ return '4g'; });
      xdef(NI, 'rtt', function(){ return _rtt; });
      xdef(NI, 'downlink', function(){ return 10; });
      xdef(NI, 'saveData', function(){ return false; });
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
        Object.defineProperty(_MDI.prototype, 'toJSON', {
          configurable: true, enumerable: true, writable: true,
          value: xmask(function(){ return { deviceId: this.deviceId, kind: this.kind, label: '', groupId: this.groupId }; }, 'toJSON')
        });
      }
    }
  } catch(e){}
} catch(e){ /* never throw into the page */ }
`
