// ── VGC Browser — stealth script generator ───────────────────────────────────
// Produces the JS injected (via CDP Page.addScriptToEvaluateOnNewDocument) into
// every document BEFORE its own scripts run. It spoofs the JS-observable parts of
// the fingerprint: navigator props, screen, WebGL vendor/renderer, and adds
// deterministic per-profile noise to canvas/audio. WebRTC leak prevention too.
//
// Noise is seeded from the profile id, so a profile looks like the SAME machine
// every session (consistency is what detectors actually check).
//
// IMPORTANT (honesty): this is JS-level spoofing. It defeats casual checks and
// many commercial detectors, but advanced introspection (creepjs lie-detection)
// can still spot JS overrides. The undetectable version lands in Phase 5 when the
// values come from our patched "VGC Core" engine at the C++ level. UA/Client
// Hints/timezone/geo are already done natively via CDP (see cdp-injector.ts).

import type { Fingerprint } from '../shared/types'
import { extraSpoofBody } from './stealth-extra'

/** Stable 32-bit FNV-1a hash of a string → noise seed. */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface StealthOptions {
  /** True when the browser is the patched VGC Core engine, which spoofs WebGL
   *  UNMASKED vendor/renderer natively (C++). In that case we MUST NOT also
   *  override getParameter in JS — the native value is already correct and a JS
   *  override only re-introduces the detectable tell the native patch removes. */
  nativeWebgl?: boolean
}

export function buildStealthScript(
  fp: Fingerprint,
  seed: number,
  opts: StealthOptions = {}
): string {
  const cfg = {
    seed,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    platform: fp.platform,
    vendor: fp.vendor,
    language: fp.language,
    languages: fp.languages,
    screen: fp.screen,
    devicePixelRatio: fp.devicePixelRatio,
    webglVendor: fp.webgl.vendor,
    webglRenderer: fp.webgl.renderer,
    nativeWebgl: opts.nativeWebgl === true,
    canvasNoise: fp.canvasNoise,
    audioNoise: fp.audioNoise,
    webrtc: fp.webrtc,
    webrtcPublicIp: fp.webrtcPublicIp ?? '',
    fonts: fp.fonts,
    doNotTrack: fp.doNotTrack
  }

  // The body below is plain JS (no template literals / no ${}) so it survives
  // being embedded in this TS template string. Only CFG is interpolated.
  // extraSpoofBody adds the vectors not covered natively (client rects, screen avail
  // offsets, navigator.connection, mediaDevices) — it reuses the mask()/def() helpers
  // STEALTH_BODY declares, so it must be concatenated AFTER STEALTH_BODY.
  return (
    '(function(){' +
    '"use strict";' +
    'var CFG = ' +
    JSON.stringify(cfg) +
    ';' +
    STEALTH_BODY +
    extraSpoofBody({ seed, clientRectsNoise: fp.clientRectsNoise === true }) +
    '})();'
  )
}

// ── The injected runtime ──────────────────────────────────────────────────────
const STEALTH_BODY = `
try {
  // Seeded PRNG (mulberry32) — deterministic per profile.
  function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

  // ── Native-identity masking ────────────────────────────────────────────────
  // Every override is a Proxy whose TARGET is the original native function, so the
  // disguise is structural instead of bookkeeping:
  //   • Function.prototype.toString.call(fn) resolves against the native target in EVERY
  //     realm. The old WeakMap only existed in the realm that installed it, so
  //     iframe.contentWindow.Function.prototype.toString.call(patchedFn) fell through to
  //     the real toString and dumped our raw source — the first check creepjs runs.
  //   • fn.name, fn.length, the ABSENCE of an own .prototype, and non-constructability
  //     all come from the target. Previously every override was a plain function
  //     expression, so fn.hasOwnProperty('prototype') was true and "new fn()" succeeded
  //     where a native method or WebIDL getter always throws — a one-line detector.
  // Consequently we no longer patch Function.prototype.toString at all: that patch was
  // itself a plain function expression, i.e. a tell that announced the whole layer.
  function nat(orig, impl){
    try {
      if (typeof orig !== 'function') return impl;
      return new Proxy(orig, { apply: function(t, self, a){ return impl.apply(self, a); } });
    } catch(e){ return impl; }
  }

  // Redefine an EXISTING accessor, reusing the native getter as the proxy target and
  // keeping the native descriptor attributes. Deliberately never CREATES a property:
  // defining one Chrome does not have (navigator.doNotTrack was removed in M135 and this
  // engine is 151) both invents the property and appends it to the end of
  // getOwnPropertyNames(Navigator.prototype), changing the native key order.
  function def(obj, prop, getter){
    try {
      var d = Object.getOwnPropertyDescriptor(obj, prop);
      if (!d || !d.get) return;
      Object.defineProperty(obj, prop, { get: nat(d.get, getter), set: d.set, configurable: d.configurable, enumerable: d.enumerable });
    } catch(e){}
  }

  // Keep CSS resolution / device-pixel-ratio media queries consistent with the spoofed
  // window.devicePixelRatio. matchMedia is evaluated in the compositor against the REAL
  // dpr, so we rewrite the threshold in each query by (spoof - real) and let the native
  // call answer — returning a genuine MediaQueryList. dpr features are unitless; resolution
  // features carry dppx/dpi/dpcm, all normalised to dppx here.
  function patchMatchMedia(realDpr, spoofDpr){
    try {
      if (typeof window.matchMedia !== 'function') return;
      if (!(realDpr > 0) || !(spoofDpr > 0)) return;
      var delta = spoofDpr - realDpr;
      if (Math.abs(delta) < 1e-9) return; // dpr already matches → no tell to hide
      var native = window.matchMedia;
      var RE = /(-webkit-)?(min-|max-)?(device-pixel-ratio|resolution)(\\s*:\\s*)([0-9.]+)(dppx|dpi|dpcm|x)?/gi;
      window.matchMedia = nat(native, function(q){
        try {
          var rq = String(q).replace(RE, function(m, wk, mm, feat, colon, num, unit){
            var v = parseFloat(num); if (!(v >= 0)) return m;
            var isRes = /resolution/i.test(feat);
            var dppx = v;
            if (isRes) {
              if (unit === 'dpi') dppx = v / 96;
              else if (unit === 'dpcm') dppx = v * 2.54 / 96;
              else dppx = v; // dppx | x
            }
            var shifted = dppx - delta;
            if (shifted < 0) shifted = 0;
            return (wk || '') + (mm || '') + feat + colon + shifted + (isRes ? 'dppx' : '');
          });
          return native.call(this, rq);
        } catch(e){ return native.call(this, q); }
      });
    } catch(e){}
  }

  // ── navigator ──
  try { def(Navigator.prototype, 'hardwareConcurrency', function(){ return CFG.hardwareConcurrency; }); } catch(e){}
  try { def(Navigator.prototype, 'deviceMemory', function(){ return CFG.deviceMemory; }); } catch(e){}
  try { def(Navigator.prototype, 'platform', function(){ return CFG.platform; }); } catch(e){}
  try { def(Navigator.prototype, 'vendor', function(){ return CFG.vendor; }); } catch(e){}
  try { def(Navigator.prototype, 'language', function(){ return CFG.language; }); } catch(e){}
  try { def(Navigator.prototype, 'languages', function(){ return Object.freeze(CFG.languages.slice()); }); } catch(e){}
  // never report automation
  try { def(Navigator.prototype, 'webdriver', function(){ return false; }); } catch(e){}
  if (CFG.doNotTrack !== 'unset') { try { def(Navigator.prototype, 'doNotTrack', function(){ return CFG.doNotTrack; }); } catch(e){} }

  // ── screen ──
  try {
    var s = CFG.screen;
    // Capture the REAL device-pixel-ratio BEFORE overriding the getter — the compositor
    // still evaluates CSS media queries against it, so we need it to keep matchMedia in
    // step with the spoofed value (see patchMatchMedia below).
    var _realDpr = window.devicePixelRatio;
    def(Screen.prototype, 'width', function(){ return s.width; });
    def(Screen.prototype, 'height', function(){ return s.height; });
    def(Screen.prototype, 'availWidth', function(){ return s.width; });
    def(Screen.prototype, 'availHeight', function(){ return s.height - 40; });
    def(Screen.prototype, 'colorDepth', function(){ return s.colorDepth; });
    def(Screen.prototype, 'pixelDepth', function(){ return s.pixelDepth; });
    def(window, 'devicePixelRatio', function(){ return CFG.devicePixelRatio; });
    // matchMedia is evaluated in the compositor against the REAL dpr, so
    // matchMedia('(resolution: <spoofDpr>dppx)') would say false while
    // window.devicePixelRatio says <spoofDpr> — a direct self-contradiction creepjs/
    // pixelscan report as "resolution spoofing detected". Rewrite the resolution /
    // device-pixel-ratio threshold in every query by the (spoof - real) delta so the
    // native evaluation against the real dpr yields the SPOOFED answer. Returns a genuine
    // MediaQueryList (native call), so addListener/matches/etc. stay real.
    patchMatchMedia(_realDpr, CFG.devicePixelRatio);
  } catch(e){}

  // ── WebGL vendor/renderer (UNMASKED) ──
  // Skipped on the VGC Core engine: it spoofs these natively (C++), so a JS
  // getParameter override here would be redundant AND re-introduce a detectable
  // JS tell. On stock Chrome (fallback) we still need the JS override.
  if (!CFG.nativeWebgl) {
    try {
      var GL_VENDOR = 37445, GL_RENDERER = 37446;
      function patchGetParam(proto){
        if(!proto) return;
        var orig = proto.getParameter;
        proto.getParameter = nat(orig, function(p){
          if(p === GL_VENDOR) return CFG.webglVendor;
          if(p === GL_RENDERER) return CFG.webglRenderer;
          return orig.call(this, p);
        });
      }
      patchGetParam(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
      patchGetParam(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    } catch(e){}
  }

  // ── Canvas noise (deterministic) ──
  if (CFG.canvasNoise) {
    try {
      // Return an OFFSCREEN copy of the canvas with the noise applied — NEVER write the noise
      // back to the source. Mutating the source made repeated toDataURL/toBlob reads accumulate
      // noise (O→O+n→O+2n→…), so the hash DRIFTED between reads of the same canvas — exactly the
      // "unstable = spoofed" tell the seeded noise exists to avoid. With the source untouched, the
      // same source pixels + the re-seeded RNG always yield the same output → a stable hash.
      function noiseInto(d){
        var cRng = mulberry32(CFG.seed);
        var step = Math.max(1, Math.floor(d.length / 4 / 64)) * 4;
        for (var i = 0; i < d.length; i += step) {
          var n = (cRng() * 3 | 0) - 1;
          d[i] = Math.min(255, Math.max(0, d[i] + n));
          d[i+1] = Math.min(255, Math.max(0, d[i+1] + n));
          d[i+2] = Math.min(255, Math.max(0, d[i+2] + n));
        }
      }
      // Captured BEFORE the getImageData override below is installed. noisify() runs at
      // call time, i.e. AFTER that patch exists, so calling ctx.getImageData() here would
      // resolve to the PATCHED one and apply noiseInto once already — then line "noiseInto
      // (img.data)" applied it a second time. Net effect: toDataURL/toBlob returned
      // original+2·noise while getImageData returned original+1·noise, so the two read
      // paths DISAGREED — the exact contradiction this block claims to prevent. Reading
      // through the pristine function keeps both paths at exactly one noise pass.
      var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      function noisify(canvas){
        try {
          // Do NOT call getContext('2d') on a context-less canvas: that permanently binds it
          // to 2D, so a later getContext('webgl') returns null — a functional break and an
          // observable anomaly. Bail out instead; a canvas with no 2D context has no 2D
          // pixels worth farbling.
          var ctx = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
          if(!ctx) return canvas;
          var w = canvas.width, h = canvas.height;
          if(!w || !h) return canvas;
          var img = origGetImageData.call(ctx, 0, 0, w, h);
          noiseInto(img.data);
          var off = document.createElement('canvas'); off.width = w; off.height = h;
          var octx = off.getContext('2d'); if(!octx) return canvas;
          octx.putImageData(img, 0, 0);
          return off;
        } catch(e){ return canvas; }
      }
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = nat(origToDataURL, function(){ return origToDataURL.apply(noisify(this), arguments); });
      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (origToBlob) HTMLCanvasElement.prototype.toBlob = nat(origToBlob, function(){ return origToBlob.apply(noisify(this), arguments); });
      CanvasRenderingContext2D.prototype.getImageData = nat(origGetImageData, function(){
        var r = origGetImageData.apply(this, arguments);
        // Same single noise pass as toDataURL/toBlob, applied only to the returned COPY,
        // so both read paths now yield identical pixels.
        try { noiseInto(r.data); } catch(e){}
        return r;
      });

      // OffscreenCanvas: the same drawing transferred to an OffscreenCanvas and read via
      // convertToBlob() / getImageData() would otherwise return the UN-noised hash,
      // contradicting the HTMLCanvas one. Cover both readback paths with the identical
      // single noise pass. (Native mode gets this in C++; this is the CDP/JS path only.)
      var OC = window.OffscreenCanvas;
      var OCtx = window.OffscreenCanvasRenderingContext2D;
      var origOffGID = OCtx && OCtx.prototype && OCtx.prototype.getImageData;
      if (OC && OC.prototype && OC.prototype.convertToBlob && origOffGID) {
        function noisifyOff(canvas){
          try {
            var ctx = canvas.getContext && canvas.getContext('2d');
            if(!ctx || typeof ctx.getImageData !== 'function') return canvas;
            var w = canvas.width, h = canvas.height;
            if(!w || !h) return canvas;
            var img = origOffGID.call(ctx, 0, 0, w, h);
            noiseInto(img.data);
            var off = new OC(w, h); var octx = off.getContext('2d');
            if(!octx) return canvas;
            octx.putImageData(img, 0, 0);
            return off;
          } catch(e){ return canvas; }
        }
        var origConvert = OC.prototype.convertToBlob;
        OC.prototype.convertToBlob = nat(origConvert, function(){ return origConvert.apply(noisifyOff(this), arguments); });
        OCtx.prototype.getImageData = nat(origOffGID, function(){
          var r = origOffGID.apply(this, arguments);
          try { noiseInto(r.data); } catch(e){}
          return r;
        });
      }
    } catch(e){}
  }

  // ── AudioContext noise (on the fingerprinting read path) ──
  if (CFG.audioNoise) {
    try {
      // The RNG must be re-seeded INSIDE the wrapper. A single stream created out here
      // advanced across calls, so two consecutive getFloatFrequencyData() reads of the
      // SAME audio returned different values — the "unstable ⇒ spoofed" tell the seeded
      // canvas noise is carefully written to avoid. Deriving the offset from the bin index
      // instead of stream order also makes it position-stable across differing array sizes.
      function aNoise(seed, i){
        var s = (seed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0;
        s ^= s>>>15; s = Math.imul(s, 0x2C1B3C6D)>>>0; s ^= s>>>12; s = Math.imul(s, 0x297A2D39)>>>0; s ^= s>>>15;
        return ((s & 0xffff)/0xffff) * 0.0002 - 0.0001;
      }
      var AP = window.AnalyserNode && AnalyserNode.prototype;
      if (AP && AP.getFloatFrequencyData) {
        var origFFD = AP.getFloatFrequencyData;
        AP.getFloatFrequencyData = nat(origFFD, function(arr){
          origFFD.call(this, arr);
          var seed = (CFG.seed ^ 0x9E3779B9) >>> 0;
          for (var i=0;i<arr.length;i+=Math.max(1, arr.length>>6)) { arr[i] = arr[i] + aNoise(seed, i); }
        });
      }
    } catch(e){}
  }

  // ── WebRTC leak handling ──
  try {
    if (CFG.webrtc === 'disabled') {
      // DELETE, don't define-as-undefined. The old version left the key present, so
      // ('RTCPeerConnection' in window) was true while window.RTCPeerConnection was
      // undefined — a state no real Chrome build is ever in, and trivially probed.
      var kill = function(k){ try { delete window[k]; } catch(e){} };
      kill('RTCPeerConnection'); kill('webkitRTCPeerConnection'); kill('RTCDataChannel');
    } else if (CFG.webrtc === 'proxy') {
      var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (RTC) {
        // Match an IPv4 OR IPv6 address in the candidate line. The old regex only caught
        // IPv4, so an IPv6 HOST candidate (typ host, e.g. 2405:4802:…) fell through to
        // "return true" and leaked the machine's real IPv6 — the proxy is IPv4-only, so
        // WebRTC over IPv6 bypassed it entirely. Catch both families.
        var ipRe = /((\\d{1,3}\\.){3}\\d{1,3})|(([a-f0-9]{1,4}:){2,}[a-f0-9:]+)/i;
        // A candidate is safe to expose only if it leaks NO real IP: mDNS-anonymized
        // (.local) host candidates are fine; a candidate carrying a real IP (v4 OR v6) is
        // allowed only when it equals the proxy's known public IP; everything else is
        // dropped so the machine's REAL public/local IP never escapes via WebRTC.
        var safeCand = function(cand){
          if (!cand) return true;
          if (cand.indexOf('.local') !== -1) return true;
          var m = cand.match(ipRe);
          if (m) { return CFG.webrtcPublicIp ? (m[0] === CFG.webrtcPublicIp) : false; }
          if (/typ srflx|typ relay|typ prflx/.test(cand)) return false;
          return true;
        };
        // Inject one srflx candidate carrying the proxy's public IP so a WebRTC leak test
        // reports the PROXY IP (matching the visible IP), not an empty result — the real IP
        // is still dropped by safeCand above.
        var PUB = CFG.webrtcPublicIp || '';
        var synth = function(){ if (!PUB || PUB.indexOf(':') !== -1) return ''; var p = PUB.split('.'); var port = 50000 + (((+p[3]||0)*13 + (+p[2]||0)*7) % 15000); return 'candidate:1853896148 1 udp 1677729535 ' + PUB + ' ' + port + ' typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999'; };
        var mkIce = function(){ var s = synth(); if (!s) return null; try { return new RTCIceCandidate({ candidate: s, sdpMid: '0', sdpMLineIndex: 0 }); } catch(e){ return { candidate: s, sdpMid: '0', sdpMLineIndex: 0, address: PUB, type: 'srflx', protocol: 'udp' }; } };
        var scrubSdp = function(sdp){
          if (!sdp) return sdp;
          var lines = String(sdp).split('\\r\\n'), out = [], at = -1;
          for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('a=candidate:') === 0 && !safeCand(lines[i])) continue;
            out.push(lines[i]);
            if (lines[i].indexOf('a=ice-pwd:') === 0 || lines[i].indexOf('a=rtcp-mux') === 0) at = out.length;
          }
          var sc = synth(); if (sc && at >= 0) out.splice(at, 0, 'a=' + sc);
          return out.join('\\r\\n');
        };
        // Everything below patches the PROTOTYPE and keeps per-connection state in a
        // WeakMap. The previous design wrapped each instance, which left a native-looking
        // RTCPeerConnection carrying own properties it can never have:
        //   Object.keys(pc)                    → ["__vgcOic","__vgcOicL"]   (native: [])
        //   pc.hasOwnProperty('onicecandidate')→ true                       (native: false)
        //   pc.addEventListener.length         → 3                          (native: 2)
        // and it replaced the constructor with a plain function, so RTCPeerConnection.length
        // was 2 instead of 0, calling it without "new" returned an object instead of throwing,
        // the static generateCertificate vanished, and pc.constructor !== RTCPeerConnection.
        // Patching the prototype removes that entire class of tell, so no constructor
        // replacement is needed at all.
        var pcState = new WeakMap();
        var st = function(pc){ var s = pcState.get(pc); if (!s) { s = { injected: false, map: new WeakMap(), oic: undefined }; pcState.set(pc, s); } return s; };
        // Filter real IPs; when gathering ends (candidate===null) inject the proxy candidate first.
        var fwd = function(pc, cb, ev){
          try {
            if (ev && ev.candidate) { if (!safeCand(ev.candidate.candidate)) return; return cb.call(pc, ev); }
            var s = st(pc);
            if (PUB && !s.injected) { s.injected = true; var ic = mkIce(); if (ic) { try { cb.call(pc, { candidate: ic, target: pc, currentTarget: pc, type: 'icecandidate' }); } catch(e){} } }
            return cb.call(pc, ev);
          } catch(e){ try { return cb.call(pc, ev); } catch(e2){} }
        };
        // addEventListener/removeEventListener live on EventTarget.prototype natively, so we
        // patch them there (proxied over the native fn) rather than adding an own property to
        // RTCPeerConnection.prototype, which would itself change its key list.
        try {
          var origAdd = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = nat(origAdd, function(type, cb, opts){
            if (type === 'icecandidate' && typeof cb === 'function' && (this instanceof RTC)) {
              var pc = this, s = st(pc), w = s.map.get(cb);
              if (!w) { w = function(ev){ return fwd(pc, cb, ev); }; s.map.set(cb, w); }
              return origAdd.call(pc, type, w, opts);
            }
            return origAdd.apply(this, arguments);
          });
          var origRm = EventTarget.prototype.removeEventListener;
          EventTarget.prototype.removeEventListener = nat(origRm, function(type, cb, opts){
            if (type === 'icecandidate' && typeof cb === 'function' && (this instanceof RTC)) {
              var w = st(this).map.get(cb);
              if (w) return origRm.call(this, type, w, opts);
            }
            return origRm.apply(this, arguments);
          });
        } catch(e){}
        // onicecandidate is a real accessor on RTCPeerConnection.prototype — redefine it there.
        try {
          var oic = Object.getOwnPropertyDescriptor(RTC.prototype, 'onicecandidate');
          if (oic && oic.get && oic.set) {
            Object.defineProperty(RTC.prototype, 'onicecandidate', {
              configurable: oic.configurable, enumerable: oic.enumerable,
              get: nat(oic.get, function(){ var s = pcState.get(this); return (s && s.oic !== undefined) ? s.oic : oic.get.call(this); }),
              set: nat(oic.set, function(cb){
                var pc = this, s = st(pc);
                s.oic = (typeof cb === 'function') ? cb : null;
                oic.set.call(pc, s.oic ? function(ev){ return fwd(pc, s.oic, ev); } : cb);
              })
            });
          }
        } catch(e){}
        // localDescription / currentLocalDescription both carry the SDP candidate lines.
        try {
          var scrubDesc = function(name){
            var ld = Object.getOwnPropertyDescriptor(RTC.prototype, name);
            if (!ld || !ld.get) return;
            Object.defineProperty(RTC.prototype, name, {
              configurable: ld.configurable, enumerable: ld.enumerable,
              get: nat(ld.get, function(){
                var d = ld.get.call(this);
                if (d && d.sdp) {
                  // Return a REAL RTCSessionDescription. The old code returned a plain object,
                  // so (d instanceof RTCSessionDescription) was false and
                  // Object.prototype.toString.call(d) said "[object Object]".
                  try { return new RTCSessionDescription({ type: d.type, sdp: scrubSdp(d.sdp) }); } catch(e){ return d; }
                }
                return d;
              })
            });
          };
          scrubDesc('localDescription'); scrubDesc('currentLocalDescription');
        } catch(e){}
      }
    }
  } catch(e){}

  // ── Fonts: clamp the JS-detectable font set to the declared list (best-effort) ──
  // Offscreen probes (FontFaceSet.check + canvas measureText) for a NON-declared
  // family behave as the generic fallback → that font looks "not installed". Does
  // NOT alter visible DOM layout, so pages still render normally.
  try {
    var GENERIC = {'serif':1,'sans-serif':1,'monospace':1,'cursive':1,'fantasy':1,'system-ui':1,'ui-serif':1,'ui-sans-serif':1,'ui-monospace':1,'ui-rounded':1,'math':1,'emoji':1,'fangsong':1,'inherit':1,'initial':1,'unset':1,'':1};
    var ALLOWED = {};
    var fl = CFG.fonts || [];
    for (var fi = 0; fi < fl.length; fi++) { ALLOWED[String(fl[fi]).toLowerCase()] = 1; }
    var famName = function(spec){ return String(spec || '').replace(/^.*?\\d+(?:px|pt|em|rem|%)\\s+/i, '').split(',')[0].trim().replace(/^["']|["']$/g, ''); };
    var familyAllowed = function(fam){ var n = String(fam || '').trim().replace(/^["']|["']$/g, '').toLowerCase(); return GENERIC[n] === 1 || ALLOWED[n] === 1; };
    // Patch FontFaceSet.prototype, not the document.fonts INSTANCE. Assigning to the
    // instance left getOwnPropertyNames(document.fonts) === ["check"] where native is [],
    // and document.fonts.hasOwnProperty('check') === true where native is false.
    if (window.FontFaceSet && FontFaceSet.prototype && FontFaceSet.prototype.check) {
      var origCheck = FontFaceSet.prototype.check;
      FontFaceSet.prototype.check = nat(origCheck, function(font, text){
        try { if (!familyAllowed(famName(font))) return false; } catch(e){}
        return origCheck.apply(this, arguments);
      });
    }
    var MT = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = nat(MT, function(t){
      try {
        var fam = famName(this.font);
        if (fam && !familyAllowed(fam)) {
          var saved = this.font;
          this.font = String(this.font).replace(fam, 'sans-serif');
          var r = MT.call(this, t);
          this.font = saved;
          return r;
        }
      } catch(e){}
      return MT.call(this, t);
    });
  } catch(e){}
} catch(e){ /* never throw into the page */ }
`
