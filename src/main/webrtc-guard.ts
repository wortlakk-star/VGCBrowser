// ── VGC Browser — WebRTC leak guard for NATIVE mode ──────────────────────────
// In native mode there is NO CDP injector, so the fingerprint-script.ts WebRTC filter
// never runs and WebRTC leaked the machine's real IPv4 AND IPv6 (the proxy is IPv4-only,
// so WebRTC over IPv6 bypassed it) — confirmed on browserleaks.com/webrtc. Chromium flags
// can't stop it (--disable-webrtc is a no-op in M151; --force-webrtc-ip-handling-policy=
// disable_non_proxied_udp still leaks). So we deliver the SAME candidate filter as a tiny
// unpacked MV3 extension whose content script runs at document_start in the page's MAIN
// world, replacing RTCPeerConnection before any page script. Written per-profile so the
// proxy's public IP can be baked in (allowed through; every other real IP is dropped).

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

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

function guardScript(webrtc: string, publicIp: string): string {
  // 'proxy'    → filter ICE candidates to the proxy's public IP (drop every other real IP,
  //              incl. IPv6 host candidates); '.local' mDNS host candidates stay (no leak).
  // 'disabled' → remove RTCPeerConnection entirely.
  return `(function(){
  var MODE=${JSON.stringify(webrtc)}, PUB=${JSON.stringify(publicIp || '')};
  try {
    if (MODE==='disabled'){
      var kill=function(k){try{Object.defineProperty(window,k,{value:undefined,configurable:true});}catch(e){}};
      kill('RTCPeerConnection');kill('webkitRTCPeerConnection');kill('RTCDataChannel');
      return;
    }
    var RTC=window.RTCPeerConnection||window.webkitRTCPeerConnection; if(!RTC) return;
    var ipRe=/((\\d{1,3}\\.){3}\\d{1,3})|(([a-f0-9]{1,4}:){2,}[a-f0-9:]+)/i;
    var safe=function(c){ if(!c) return true; if(c.indexOf('.local')!==-1) return true; var m=c.match(ipRe); if(m){return PUB?(m[0]===PUB):false;} if(/typ srflx|typ relay|typ prflx/.test(c)) return false; return true; };
    var scrub=function(s){ if(!s) return s; var L=String(s).split('\\r\\n'),o=[]; for(var i=0;i<L.length;i++){ if(L[i].indexOf('a=candidate:')===0&&!safe(L[i])) continue; o.push(L[i]); } return o.join('\\r\\n'); };
    var wrap=function(pc){
      var add=pc.addEventListener.bind(pc);
      pc.addEventListener=function(t,cb,o){ if(t==='icecandidate'&&typeof cb==='function'){ return add(t,function(ev){try{if(ev&&ev.candidate&&!safe(ev.candidate.candidate))return;}catch(e){}return cb.call(pc,ev);},o);} return add(t,cb,o); };
      try{Object.defineProperty(pc,'onicecandidate',{configurable:true,get:function(){return this.__o||null;},set:function(cb){this.__o=cb;add('icecandidate',function(ev){try{if(ev&&ev.candidate&&!safe(ev.candidate.candidate))return;}catch(e){}if(typeof cb==='function')return cb.call(pc,ev);});}});}catch(e){}
      try{var ld=Object.getOwnPropertyDescriptor(RTC.prototype,'localDescription');if(ld&&ld.get){Object.defineProperty(pc,'localDescription',{configurable:true,get:function(){var d=ld.get.call(this);if(d&&d.sdp){try{return {type:d.type,sdp:scrub(d.sdp)};}catch(e){}}return d;}});}}catch(e){}
      return pc;
    };
    var W=function(a,b){return wrap(new RTC(a,b));}; W.prototype=RTC.prototype;
    try { window.RTCPeerConnection=W; } catch(e){}
    try { window.webkitRTCPeerConnection=W; } catch(e){}
  } catch(e){}
})();`
}

/**
 * Write the per-profile WebRTC-guard extension into the profile's user-data-dir and return
 * its directory (to pass to --load-extension), or null when no guard is needed ('real' mode
 * or a write failure — never break a launch over this). It lives OUTSIDE Default/ so the
 * cloud sync (which only zips Default/) never carries this machine's proxy IP elsewhere.
 */
export function ensureWebRtcGuardExtension(
  userDataDir: string,
  webrtc: string,
  webrtcPublicIp: string
): string | null {
  if (webrtc === 'real') return null
  const dir = join(userDataDir, 'vgc-webrtc-guard')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), MANIFEST)
    writeFileSync(join(dir, 'guard.js'), guardScript(webrtc, webrtcPublicIp))
    return dir
  } catch {
    return null
  }
}
