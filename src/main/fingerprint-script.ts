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

/** Stable 32-bit FNV-1a hash of a string → noise seed. */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function buildStealthScript(fp: Fingerprint, seed: number): string {
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
    canvasNoise: fp.canvasNoise,
    audioNoise: fp.audioNoise,
    webrtc: fp.webrtc,
    webrtcPublicIp: fp.webrtcPublicIp ?? '',
    doNotTrack: fp.doNotTrack
  }

  // The body below is plain JS (no template literals / no ${}) so it survives
  // being embedded in this TS template string. Only CFG is interpolated.
  return (
    '(function(){' +
    '"use strict";' +
    'var CFG = ' +
    JSON.stringify(cfg) +
    ';' +
    STEALTH_BODY +
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
  function mask(fn, name){ try{ _native.set(fn, 'function ' + name + '() { [native code] }'); }catch(e){} return fn; }
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

  // ── Canvas noise (deterministic) ──
  if (CFG.canvasNoise) {
    try {
      var cRng = mulberry32(CFG.seed);
      function noisify(canvas){
        try {
          var ctx = canvas.getContext('2d');
          if(!ctx) return;
          var w = canvas.width, h = canvas.height;
          if(!w || !h) return;
          var img = ctx.getImageData(0, 0, w, h);
          var d = img.data;
          // perturb a sparse, seeded set of pixels by +-1 — visually invisible.
          var step = Math.max(1, Math.floor(d.length / 4 / 64)) * 4;
          for (var i = 0; i < d.length; i += step) {
            var n = (cRng() * 3 | 0) - 1;
            d[i] = Math.min(255, Math.max(0, d[i] + n));
            d[i+1] = Math.min(255, Math.max(0, d[i+1] + n));
            d[i+2] = Math.min(255, Math.max(0, d[i+2] + n));
          }
          ctx.putImageData(img, 0, 0);
        } catch(e){}
      }
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = mask(function(){ noisify(this); return origToDataURL.apply(this, arguments); }, 'toDataURL');
      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (origToBlob) HTMLCanvasElement.prototype.toBlob = mask(function(){ noisify(this); return origToBlob.apply(this, arguments); }, 'toBlob');
      var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = mask(function(){
        var r = origGetImageData.apply(this, arguments);
        try { var dd = r.data; var st = Math.max(4, Math.floor(dd.length / 4 / 64) * 4); for (var k=0;k<dd.length;k+=st){ var nn=(cRng()*3|0)-1; dd[k]=Math.min(255,Math.max(0,dd[k]+nn)); } } catch(e){}
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
      // Strip ICE candidates that reveal local/private (mDNS/host) IPs.
      var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (RTC) {
        var Wrapped = function(cfg2, con){
          var pc = new RTC(cfg2, con);
          var origAdd = pc.addEventListener;
          pc.addEventListener = function(type, cb, opts){
            if (type === 'icecandidate' && typeof cb === 'function') {
              var wrapped = function(ev){
                try {
                  var cand = (ev && ev.candidate && ev.candidate.candidate) || '';
                  if (cand) {
                    if (CFG.webrtcPublicIp) {
                      if (cand.indexOf(CFG.webrtcPublicIp) === -1) return;
                    } else if (/typ host|\\.local|192\\.168\\.| 10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\./.test(cand)) {
                      return;
                    }
                  }
                } catch(e){}
                return cb.call(this, ev);
              };
              return origAdd.call(this, type, wrapped, opts);
            }
            return origAdd.call(this, type, cb, opts);
          };
          return pc;
        };
        Wrapped.prototype = RTC.prototype;
        try { window.RTCPeerConnection = mask(Wrapped, 'RTCPeerConnection'); } catch(e){}
        try { window.webkitRTCPeerConnection = window.RTCPeerConnection; } catch(e){}
      }
    }
  } catch(e){}
} catch(e){ /* never throw into the page */ }
`
