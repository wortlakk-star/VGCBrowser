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

  // toString masking: make patched fns report as native code.
  var _toString = Function.prototype.toString;
  var _native = new WeakMap();
  function mask(fn, name){ try{ _native.set(fn, 'function ' + name + '() { [native code] }'); Object.defineProperty(fn, 'name', { value: name, configurable: true }); }catch(e){} return fn; }
  var patchedToString = function toString(){ if(_native.has(this)) return _native.get(this); return _toString.call(this); };
  Function.prototype.toString = mask(patchedToString, 'toString');

  function def(obj, prop, getter){
    try { Object.defineProperty(obj, prop, { get: mask(getter, 'get ' + prop), configurable: true, enumerable: true }); } catch(e){}
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
    def(Screen.prototype, 'width', function(){ return s.width; });
    def(Screen.prototype, 'height', function(){ return s.height; });
    def(Screen.prototype, 'availWidth', function(){ return s.width; });
    def(Screen.prototype, 'availHeight', function(){ return s.height - 40; });
    def(Screen.prototype, 'colorDepth', function(){ return s.colorDepth; });
    def(Screen.prototype, 'pixelDepth', function(){ return s.pixelDepth; });
    Object.defineProperty(window, 'devicePixelRatio', { get: mask(function(){ return CFG.devicePixelRatio; }, 'get devicePixelRatio'), configurable: true });
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
        proto.getParameter = mask(function(p){
          if(p === GL_VENDOR) return CFG.webglVendor;
          if(p === GL_RENDERER) return CFG.webglRenderer;
          return orig.call(this, p);
        }, 'getParameter');
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
      function noisify(canvas){
        try {
          var ctx = canvas.getContext('2d');
          if(!ctx) return canvas;
          var w = canvas.width, h = canvas.height;
          if(!w || !h) return canvas;
          var img = ctx.getImageData(0, 0, w, h);
          noiseInto(img.data);
          var off = document.createElement('canvas'); off.width = w; off.height = h;
          var octx = off.getContext('2d'); if(!octx) return canvas;
          octx.putImageData(img, 0, 0);
          return off;
        } catch(e){ return canvas; }
      }
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = mask(function(){ return origToDataURL.apply(noisify(this), arguments); }, 'toDataURL');
      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (origToBlob) HTMLCanvasElement.prototype.toBlob = mask(function(){ return origToBlob.apply(noisify(this), arguments); }, 'toBlob');
      var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = mask(function(){
        var r = origGetImageData.apply(this, arguments);
        // Same noise routine as toDataURL/toBlob so the two read paths agree (they mutate only the
        // returned COPY, never the canvas). Previously getImageData noised the R channel only with
        // a different step, so its hash disagreed with toDataURL's.
        try { noiseInto(r.data); } catch(e){}
        return r;
      }, 'getImageData');
    } catch(e){}
  }

  // ── AudioContext noise (on the fingerprinting read path) ──
  if (CFG.audioNoise) {
    try {
      var aRng = mulberry32(CFG.seed ^ 0x9E3779B9);
      var AP = window.AnalyserNode && AnalyserNode.prototype;
      if (AP && AP.getFloatFrequencyData) {
        var origFFD = AP.getFloatFrequencyData;
        AP.getFloatFrequencyData = mask(function(arr){
          origFFD.call(this, arr);
          for (var i=0;i<arr.length;i+=Math.max(1, arr.length>>6)) { arr[i] = arr[i] + (aRng() * 0.0002 - 0.0001); }
        }, 'getFloatFrequencyData');
      }
    } catch(e){}
  }

  // ── WebRTC leak handling ──
  try {
    if (CFG.webrtc === 'disabled') {
      var kill = function(k){ try { Object.defineProperty(window, k, { value: undefined, configurable: true }); } catch(e){} };
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
        var wrapPc = function(pc){
          var origAdd = pc.addEventListener.bind(pc);
          var origRm = pc.removeEventListener.bind(pc);
          var injected = false;
          // Filter real IPs; when gathering ends (candidate===null) inject the proxy candidate first.
          var fwd = function(cb, ev){ try { if (ev && ev.candidate) { if (!safeCand(ev.candidate.candidate)) return; return cb.call(pc, ev); } if (PUB && !injected) { injected = true; var ic = mkIce(); if (ic) { try { cb.call(pc, { candidate: ic, target: pc, currentTarget: pc, type: 'icecandidate' }); } catch(e){} } } return cb.call(pc, ev); } catch(e){ try { return cb.call(pc, ev); } catch(e2){} } };
          pc.addEventListener = mask(function(type, cb, opts){
            if (type === 'icecandidate' && typeof cb === 'function') {
              return origAdd(type, function(ev){ return fwd(cb, ev); }, opts);
            }
            return origAdd(type, cb, opts);
          }, 'addEventListener');
          try {
            Object.defineProperty(pc, 'onicecandidate', {
              configurable: true,
              get: function(){ return this.__vgcOic || null; },
              set: function(cb){
                // Replace, don't stack: remove the previous wrapper listener before adding a new
                // one (and add none when cb isn't a function), so onicecandidate is a single
                // assignable handler and setting it to null actually detaches the listener.
                if (this.__vgcOicL) { try { origRm('icecandidate', this.__vgcOicL); } catch(e){} this.__vgcOicL = null; }
                this.__vgcOic = (typeof cb === 'function') ? cb : null;
                if (this.__vgcOic) {
                  this.__vgcOicL = function(ev){ return fwd(cb, ev); };
                  origAdd('icecandidate', this.__vgcOicL);
                }
              }
            });
          } catch(e){}
          try {
            var ld = Object.getOwnPropertyDescriptor(RTC.prototype, 'localDescription');
            if (ld && ld.get) {
              Object.defineProperty(pc, 'localDescription', { configurable: true, get: function(){ var d = ld.get.call(this); if (d && d.sdp) { try { return { type: d.type, sdp: scrubSdp(d.sdp) }; } catch(e){} } return d; } });
            }
          } catch(e){}
          return pc;
        };
        var Wrapped = function(cfg2, con){ return wrapPc(new RTC(cfg2, con)); };
        Wrapped.prototype = RTC.prototype;
        try { window.RTCPeerConnection = mask(Wrapped, 'RTCPeerConnection'); } catch(e){}
        try { window.webkitRTCPeerConnection = window.RTCPeerConnection; } catch(e){}
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
    if (document.fonts && document.fonts.check) {
      var origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = mask(function(font, text){ try { if (!familyAllowed(famName(font))) return false; } catch(e){} return origCheck(font, text); }, 'check');
    }
    var MT = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = mask(function(t){
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
    }, 'measureText');
  } catch(e){}
} catch(e){ /* never throw into the page */ }
`
