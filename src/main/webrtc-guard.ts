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
import { extraSpoofBody } from './stealth-extra'

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
      all_frames: true
    }
  ]
})

// toString-masking preamble + def() helper — identical technique to fingerprint-script.ts,
// so a detector reading getter.toString() sees "function get width() { [native code] }"
// instead of our source. Shared by the screen + WebRTC blocks below via closure.
const MASK_PREAMBLE = `
  var _toString=Function.prototype.toString, _native=new WeakMap();
  function mask(fn,name){try{_native.set(fn,'function '+name+'() { [native code] }');}catch(e){}return fn;}
  var patchedToString=function toString(){if(_native.has(this))return _native.get(this);return _toString.call(this);};
  Function.prototype.toString=mask(patchedToString,'toString');
  function def(obj,prop,getter){try{Object.defineProperty(obj,prop,{get:mask(getter,'get '+prop),configurable:true,enumerable:true});}catch(e){}}
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
  return `
  try {
    var S=${cfg};
    def(Screen.prototype,'width',function(){return S.width;});
    def(Screen.prototype,'height',function(){return S.height;});
    def(Screen.prototype,'availWidth',function(){return S.width;});
    def(Screen.prototype,'availHeight',function(){return S.height-40;});
    def(Screen.prototype,'colorDepth',function(){return S.colorDepth;});
    def(Screen.prototype,'pixelDepth',function(){return S.pixelDepth;});
    Object.defineProperty(window,'devicePixelRatio',{get:mask(function(){return S.dpr;},'get devicePixelRatio'),configurable:true});
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
      var kill=function(k){try{Object.defineProperty(window,k,{value:undefined,configurable:true});}catch(e){}};
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
        var wrap=function(pc){
          var add=pc.addEventListener.bind(pc);
          var rm=pc.removeEventListener.bind(pc);
          var injected=false;
          // Filter real IPs; when gathering ends (candidate===null) inject the proxy candidate first.
          var fwd=function(cb,ev){ try{ if(ev&&ev.candidate){ if(!safe(ev.candidate.candidate)) return; return cb.call(pc,ev); } if(PUB&&!injected){ injected=true; var ic=mkIce(); if(ic){ try{ cb.call(pc,{candidate:ic,target:pc,currentTarget:pc,type:'icecandidate'}); }catch(e){} } } return cb.call(pc,ev); }catch(e){ try{return cb.call(pc,ev);}catch(e2){} } };
          pc.addEventListener=mask(function(t,cb,o){ if(t==='icecandidate'&&typeof cb==='function'){ return add(t,function(ev){return fwd(cb,ev);},o);} return add(t,cb,o); },'addEventListener');
          try{Object.defineProperty(pc,'onicecandidate',{configurable:true,get:function(){return this.__o||null;},set:function(cb){if(this.__ol){try{rm('icecandidate',this.__ol);}catch(e){}this.__ol=null;}this.__o=(typeof cb==='function')?cb:null;if(this.__o){this.__ol=function(ev){return fwd(cb,ev);};add('icecandidate',this.__ol);}}});}catch(e){}
          try{var ld=Object.getOwnPropertyDescriptor(RTC.prototype,'localDescription');if(ld&&ld.get){Object.defineProperty(pc,'localDescription',{configurable:true,get:function(){var d=ld.get.call(this);if(d&&d.sdp){try{return {type:d.type,sdp:scrub(d.sdp)};}catch(e){}}return d;}});}}catch(e){}
          return pc;
        };
        var W=function(a,b){return wrap(new RTC(a,b));}; W.prototype=RTC.prototype; mask(W,'RTCPeerConnection');
        try { window.RTCPeerConnection=W; } catch(e){}
        try { window.webkitRTCPeerConnection=W; } catch(e){}
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
      MASK_PREAMBLE +
      screenScript(fp) +
      (fp.webrtc !== 'real' ? webrtcScript(fp.webrtc, fp.webrtcPublicIp ?? '') : '') +
      extraSpoofBody({ seed, clientRectsNoise: fp.clientRectsNoise === true }) +
      '})();'
    writeFileSync(join(dir, 'guard.js'), body)
    return dir
  } catch {
    return null
  }
}
