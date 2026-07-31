// ── VGC Browser — native-mode fingerprint guard (WebRTC + screen) ────────────
// In native mode there is NO CDP injector, so fingerprint-script.ts never runs. Two of
// the things it does still need doing, delivered here as a tiny unpacked MV3 extension
// whose content script runs at document_start in the page's MAIN world (before any page
// script), written per-profile:
//   1. WebRTC leak filter — WebRTC leaked the machine's real IPv4 AND IPv6 (the proxy is
//      IPv4-only, so WebRTC over IPv6 bypassed it) — confirmed on browserleaks.com/webrtc.
//      Chromium flags can't stop it (--disable-webrtc is a no-op in M151;
//      --force-webrtc-ip-handling-policy=disable_non_proxied_udp still leaks). We filter ICE
//      candidates to the proxy's public IP (drop every other real IP).
//   2. Screen spoof — screen.width/height/availWidth/availHeight/colorDepth + devicePixelRatio.
//      Without it EVERY profile on this machine reported the same real display (screen is not
//      a Chromium switch), tying all "different" accounts to one device. This mirrors
//      fingerprint-script.ts (CDP mode) exactly, incl. the toString masking so patched getters
//      report as native code.

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Fingerprint } from '../shared/types'
import { extraSpoofBody, CAPTCHA_FRAME_BAILOUT } from './stealth-extra'

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'VGC',
  version: '1.0',
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['guard.js'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: true,
      // all_frames alone only covers frames whose URL <all_urls> can match — i.e.
      // http/https/ftp/file. An about:blank / about:srcdoc / data: / blob: iframe
      // matched NOTHING, so the guard never ran there and the page could read the
      // host's REAL screen, devicePixelRatio and WebRTC candidates out of a one-line
      // iframe. That is the classic antidetect hole pixelscan/creepjs probe first.
      match_about_blank: true,
      match_origin_as_fallback: true
    }
  ]
})

// Native-identity preamble — identical technique to fingerprint-script.ts. Each override is
// a Proxy over the ORIGINAL native function, so toString(), name, length, the absence of an
// own .prototype and non-constructability all resolve against the native target, in EVERY
// realm. The previous WeakMap version only worked in the realm that installed it, so
// iframe.contentWindow.Function.prototype.toString.call(getter) printed our raw source.
// Nothing patches Function.prototype.toString any more — that patch was itself a plain
// function expression, i.e. the very tell it was meant to hide.
const MASK_PREAMBLE = `
  function nat(orig,impl){try{ if(typeof orig!=='function') return impl; return new Proxy(orig,{apply:function(t,self,a){return impl.apply(self,a);}}); }catch(e){ return impl; }}
  function def(obj,prop,getter){try{var d=Object.getOwnPropertyDescriptor(obj,prop);if(!d||!d.get)return;Object.defineProperty(obj,prop,{get:nat(d.get,getter),set:d.set,configurable:d.configurable,enumerable:d.enumerable});}catch(e){}}
  // Keep CSS resolution / device-pixel-ratio AND device-width/device-height media queries
  // consistent with the spoofed screen: matchMedia is evaluated against the REAL display in
  // the compositor (the native Screen.width spoof does NOT reach the media-query source), so
  // screen.width could say 1920 while (device-width:1920px) says false — a self-contradiction
  // creepjs/pixelscan flag. We shift each query threshold and let the native call answer:
  //   • dpr/resolution → shift by (spoof-real) dpr (dpr is unknown to the compositor spoof).
  //   • device-width/height → discover the REAL px via a binary search on the native evaluator,
  //     then rewrite each queried value X to X+(real-spoof). The native compare against the real
  //     px then yields the SAME boolean as a compare against the spoofed px (exact/min/max).
  function patchMatchMedia(realDpr,spoofDpr,spoofW,spoofH){try{
    if(typeof window.matchMedia!=='function')return;
    var native=window.matchMedia;
    var dprDelta=(realDpr>0&&spoofDpr>0)?(spoofDpr-realDpr):0;
    function realDim(feat){try{var lo=0,hi=32768;for(var i=0;i<16;i++){var mid=(lo+hi+1)>>1;if(native.call(window,'(min-'+feat+': '+mid+'px)').matches)lo=mid;else hi=mid-1;}return lo;}catch(e){return 0;}}
    var realW=(spoofW>0)?realDim('device-width'):0;
    var realH=(spoofH>0)?realDim('device-height'):0;
    var wDelta=(realW>0)?(realW-spoofW):0;
    var hDelta=(realH>0)?(realH-spoofH):0;
    if(Math.abs(dprDelta)<1e-9&&wDelta===0&&hDelta===0)return;
    var RES=/(-webkit-)?(min-|max-)?(device-pixel-ratio|resolution)(\\s*:\\s*)([0-9.]+)(dppx|dpi|dpcm|x)?/gi;
    var DIM=/(min-|max-)?(device-width|device-height)(\\s*:\\s*)([0-9.]+)px/gi;
    window.matchMedia=nat(native,function(q){try{
      var rq=String(q);
      if(Math.abs(dprDelta)>=1e-9)rq=rq.replace(RES,function(m,wk,mm,feat,colon,num,unit){
        var v=parseFloat(num); if(!(v>=0))return m;
        var isRes=/resolution/i.test(feat); var dppx=v;
        if(isRes){ if(unit==='dpi')dppx=v/96; else if(unit==='dpcm')dppx=v*2.54/96; else dppx=v; }
        var shifted=dppx-dprDelta; if(shifted<0)shifted=0;
        return (wk||'')+(mm||'')+feat+colon+shifted+(isRes?'dppx':'');
      });
      if(wDelta||hDelta)rq=rq.replace(DIM,function(m,mm,feat,colon,num){
        var v=parseFloat(num); if(!(v>=0))return m;
        var sh=v+(feat==='device-width'?wDelta:hDelta); if(sh<0)sh=0;
        return (mm||'')+feat+colon+sh+'px';
      });
      return native.call(this,rq);
    }catch(e){return native.call(this,q);}});
  }catch(e){}}
`

function screenScript(fp: Fingerprint): string {
  const s = fp.screen
  const cfg = JSON.stringify({
    width: s.width,
    height: s.height,
    colorDepth: s.colorDepth,
    pixelDepth: s.pixelDepth ?? s.colorDepth,
    dpr: fp.devicePixelRatio
  })
  // __vgcScreenNative: is the VGC Core ENGINE running (vs a system-Chrome fallback)? screen.cc
  // spoofs screen.width/height natively, so if the RAW screen.width already equals the target the
  // engine is present. This ONE signal gates every vector the engine ALSO spoofs natively:
  //   • screen   → skip the JS Screen.prototype getters (the native accessor is undetectable; a JS
  //                getter on top would re-introduce the exact tell the native patch removes).
  //   • client rects + connection → skipped in stealth-extra on the same signal. The deployed
  //     engine (vgc-core-156) farbles getClientRects/getBoundingClientRect (element.cc, UNION) AND
  //     spoofs NetworkInformation (network_information.cc) for window+workers. Running the JS half
  //     on top produced bcr!=cr and a window↔worker rtt mismatch — so it MUST be skipped when
  //     __vgcScreenNative is true. It runs ONLY on the system-Chrome FALLBACK (engine blocked →
  //     stock Chrome ignores --vgc-*, screen.width != target → __vgcScreenNative false → JS applies).
  // devicePixelRatio + matchMedia have no native patch, so they always apply.
  return `
  try {
    var S=${cfg};
    var _realDpr=window.devicePixelRatio;
    var __vgcScreenNative=(screen.width===S.width&&screen.height===S.height&&S.width>0);
    if(!__vgcScreenNative){
      def(Screen.prototype,'width',function(){return S.width;});
      def(Screen.prototype,'height',function(){return S.height;});
      def(Screen.prototype,'availWidth',function(){return S.width;});
      def(Screen.prototype,'availHeight',function(){return S.height-40;});
      def(Screen.prototype,'colorDepth',function(){return S.colorDepth;});
      def(Screen.prototype,'pixelDepth',function(){return S.pixelDepth;});
    }
    def(window,'devicePixelRatio',function(){return S.dpr;});
    patchMatchMedia(_realDpr,S.dpr,S.width,S.height);
  } catch(e){}
`
}

function webrtcScript(webrtc: string, publicIp: string): string {
  // 'proxy'    → make WebRTC behave like a real user behind this proxy: DROP every real IP
  //              (host v4/v6, srflx/relay) so the machine's IP never leaks, KEEP '.local'
  //              mDNS host candidates, and INJECT one srflx candidate carrying the proxy's
  //              public IP — so a leak test (browserleaks/ipleak/whoer) reports the PROXY IP,
  //              exactly matching the visible IP, instead of an empty result.
  // 'disabled' → remove RTCPeerConnection entirely.
  return `
  try {
    var MODE=${JSON.stringify(webrtc)}, PUB=${JSON.stringify(publicIp || '')};
    if (MODE==='disabled'){
      // DELETE rather than define-as-undefined: the old form left ('RTCPeerConnection' in
      // window) true while the value was undefined — a state no real Chrome is ever in.
      var kill=function(k){try{delete window[k];}catch(e){}};
      kill('RTCPeerConnection');kill('webkitRTCPeerConnection');kill('RTCDataChannel');
    } else {
      var RTC=window.RTCPeerConnection||window.webkitRTCPeerConnection;
      if(RTC){
        var ipRe=/((\\d{1,3}\\.){3}\\d{1,3})|(([a-f0-9]{1,4}:){2,}[a-f0-9:]+)/i;
        var safe=function(c){ if(!c) return true; if(c.indexOf('.local')!==-1) return true; var m=c.match(ipRe); if(m){return PUB?(m[0]===PUB):false;} if(/typ srflx|typ relay|typ prflx/.test(c)) return false; return true; };
        // Synthetic srflx candidate carrying the proxy IP (stable port derived from the IP).
        var synth=function(){ if(!PUB||PUB.indexOf(':')!==-1) return ''; var p=PUB.split('.'); var port=50000+(((+p[3]||0)*13+(+p[2]||0)*7)%15000); return 'candidate:1853896148 1 udp 1677729535 '+PUB+' '+port+' typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999'; };
        var mkIce=function(){ var s=synth(); if(!s) return null; try{ return new RTCIceCandidate({candidate:s,sdpMid:'0',sdpMLineIndex:0}); }catch(e){ return {candidate:s,sdpMid:'0',sdpMLineIndex:0,address:PUB,type:'srflx',protocol:'udp'}; } };
        var scrub=function(s){ if(!s) return s; var L=String(s).split('\\r\\n'),o=[],at=-1; for(var i=0;i<L.length;i++){ if(L[i].indexOf('a=candidate:')===0&&!safe(L[i])) continue; o.push(L[i]); if(L[i].indexOf('a=ice-pwd:')===0||L[i].indexOf('a=rtcp-mux')===0) at=o.length; } var sc=synth(); if(sc&&at>=0){ o.splice(at,0,'a='+sc); } return o.join('\\r\\n'); };
        // Patch the PROTOTYPE, keep per-connection state in a WeakMap. Wrapping each
        // instance left own properties a native RTCPeerConnection can never have —
        // Object.keys(pc) returned ["__o","__ol"] (native: []) and pc.hasOwnProperty
        // ('onicecandidate') was true (native: false) — and replacing the constructor made
        // RTCPeerConnection.length 2 instead of 0, let it be called without "new", dropped
        // the static generateCertificate and broke pc.constructor identity.
        var pcState=new WeakMap();
        var st=function(pc){var s=pcState.get(pc); if(!s){s={injected:false,map:new WeakMap(),oic:undefined};pcState.set(pc,s);} return s;};
        // Filter real IPs; when gathering ends (candidate===null) inject the proxy candidate first.
        var fwd=function(pc,cb,ev){ try{ if(ev&&ev.candidate){ if(!safe(ev.candidate.candidate)) return; return cb.call(pc,ev); } var s=st(pc); if(PUB&&!s.injected){ s.injected=true; var ic=mkIce(); if(ic){ try{ cb.call(pc,{candidate:ic,target:pc,currentTarget:pc,type:'icecandidate'}); }catch(e){} } } return cb.call(pc,ev); }catch(e){ try{return cb.call(pc,ev);}catch(e2){} } };
        try{
          var _add=EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener=nat(_add,function(t,cb,o){
            if(t==='icecandidate'&&typeof cb==='function'&&(this instanceof RTC)){
              var pc=this,s=st(pc),w=s.map.get(cb);
              if(!w){ w=function(ev){return fwd(pc,cb,ev);}; s.map.set(cb,w); }
              return _add.call(pc,t,w,o);
            }
            return _add.apply(this,arguments);
          });
          var _rm=EventTarget.prototype.removeEventListener;
          EventTarget.prototype.removeEventListener=nat(_rm,function(t,cb,o){
            if(t==='icecandidate'&&typeof cb==='function'&&(this instanceof RTC)){
              var w=st(this).map.get(cb);
              if(w) return _rm.call(this,t,w,o);
            }
            return _rm.apply(this,arguments);
          });
        }catch(e){}
        try{
          var oic=Object.getOwnPropertyDescriptor(RTC.prototype,'onicecandidate');
          if(oic&&oic.get&&oic.set){
            Object.defineProperty(RTC.prototype,'onicecandidate',{
              configurable:oic.configurable,enumerable:oic.enumerable,
              get:nat(oic.get,function(){var s=pcState.get(this);return (s&&s.oic!==undefined)?s.oic:oic.get.call(this);}),
              set:nat(oic.set,function(cb){var pc=this,s=st(pc);s.oic=(typeof cb==='function')?cb:null;oic.set.call(pc,s.oic?function(ev){return fwd(pc,s.oic,ev);}:cb);})
            });
          }
        }catch(e){}
        try{
          var scrubDesc=function(name){
            var ld=Object.getOwnPropertyDescriptor(RTC.prototype,name);
            if(!ld||!ld.get) return;
            Object.defineProperty(RTC.prototype,name,{
              configurable:ld.configurable,enumerable:ld.enumerable,
              // Returns a REAL RTCSessionDescription — the old plain object failed
              // (d instanceof RTCSessionDescription) and stringified as "[object Object]".
              get:nat(ld.get,function(){var d=ld.get.call(this);if(d&&d.sdp){try{return new RTCSessionDescription({type:d.type,sdp:scrub(d.sdp)});}catch(e){return d;}}return d;})
            });
          };
          scrubDesc('localDescription'); scrubDesc('currentLocalDescription');
        }catch(e){}
      }
    }
  } catch(e){}
`
}

/**
 * Write the per-profile native-mode guard extension into the profile's user-data-dir and
 * return its directory (to pass to --load-extension), or null on write failure (never break
 * a launch over this). Always spoofs the screen; adds the WebRTC filter unless webrtc==='real';
 * always applies the shared extra spoofs (client rects / screen avail offsets /
 * navigator.connection / mediaDevices) that the native engine does not yet cover.
 * It lives OUTSIDE Default/ so the cloud sync (which only zips Default/) never carries this
 * machine's proxy IP elsewhere.
 *
 * `seed` is the same per-profile noise seed the engine gets via --vgc-seed
 * (seedFromString(profile.id)), so JS-mode and native-mode noise are derived identically.
 */
export function ensureNativeGuardExtension(
  userDataDir: string,
  fp: Fingerprint,
  seed: number
): string | null {
  const dir = join(userDataDir, 'vgc-webrtc-guard')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), MANIFEST)
    const body =
      '(function(){' +
      CAPTCHA_FRAME_BAILOUT +
      MASK_PREAMBLE +
      screenScript(fp) +
      (fp.webrtc !== 'real' ? webrtcScript(fp.webrtc, fp.webrtcPublicIp ?? '') : '') +
      extraSpoofBody({ seed, clientRectsNoise: fp.clientRectsNoise === true, deviceMemory: fp.deviceMemory }) +
      '})();'
    writeFileSync(join(dir, 'guard.js'), body)
    return dir
  } catch {
    return null
  }
}
