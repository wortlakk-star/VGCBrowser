// ── VGC Browser — extension "VGC Passkeys" (nạp tự động vào mọi profile) ───────
// Lớp mỏng nối trang web với kho passkey trong app (passkeys.ts):
//   trang (MAIN world, main.js)  --CustomEvent-->  isolated.js  --runtime msg-->  background.js
//   --fetch 127.0.0.1 (token riêng mỗi lần mở profile)-->  app (sinh khoá / ký / lưu).
// main.js thay navigator.credentials.create/get cho yêu cầu WebAuthn và dựng lại đối tượng
// PublicKeyCredential từ dữ liệu app trả về. KHÔNG có khoá riêng nào đi qua extension hay trang.
// Extension được ghi vào thư mục profile (ngoài Default/) mỗi lần mở. Tắt cho từng profile bằng
// Profile.passkeys = false (Sửa profile).

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ensureServer, tokenFor } from './lock-ext'

const MATCHES = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'VGC Passkeys',
  version: '1.0',
  host_permissions: ['http://127.0.0.1/*'],
  background: { service_worker: 'background.js' },
  content_scripts: [
    { matches: MATCHES, js: ['isolated.js'], run_at: 'document_start', all_frames: true },
    { matches: MATCHES, js: ['main.js'], run_at: 'document_start', all_frames: true, world: 'MAIN' }
  ]
})

const BACKGROUND_JS = String.raw`importScripts('config.js');
var OPS = { create: 1, get: 1, has: 1 };
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || msg.type !== 'pk' || !OPS[msg.op]) return;
  (async function () {
    try {
      var body = Object.assign({}, msg.data || {}, { t: VGC.token, origin: String(msg.origin || '') });
      var r = await fetch('http://127.0.0.1:' + VGC.port + '/pk/' + msg.op, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      sendResponse(await r.json());
    } catch (e) {
      sendResponse({ ok: false, err: 'NotAllowedError', msg: 'Không kết nối được VGC Browser.' });
    }
  })();
  return true;
});
`

const ISOLATED_JS = String.raw`window.addEventListener('__vgcpk_req', function (e) {
  var req;
  try { req = JSON.parse(e.detail); } catch (_) { return; }
  var out = function (obj) {
    window.dispatchEvent(new CustomEvent('__vgcpk_res', { detail: JSON.stringify(obj) }));
  };
  try {
    chrome.runtime.sendMessage(
      { type: 'pk', op: req.op, origin: window.location.origin, data: req.data },
      function (r) {
        if (chrome.runtime.lastError || !r) {
          out({ id: req.id, ok: false, err: 'NotAllowedError', msg: 'Không kết nối được VGC Browser.' });
          return;
        }
        r.id = req.id;
        out(r);
      }
    );
  } catch (_e) {
    out({ id: req.id, ok: false, err: 'NotAllowedError' });
  }
});
`

const MAIN_JS = String.raw`(function () {
  if (window.__vgcpkInstalled) return;
  var CC = window.CredentialsContainer, PKC = window.PublicKeyCredential;
  if (!CC || !PKC || !navigator.credentials) return;
  Object.defineProperty(window, '__vgcpkInstalled', { value: true });

  var origCreate = CC.prototype.create, origGet = CC.prototype.get;
  var pending = {}, seq = 0;

  function toB64u(buf) {
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64u(str) {
    var b = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var s = atob(b), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out.buffer;
  }

  window.addEventListener('__vgcpk_res', function (e) {
    var d;
    try { d = JSON.parse(e.detail); } catch (_) { return; }
    var p = pending[d.id];
    if (p) { delete pending[d.id]; p(d); }
  });
  function call(op, data) {
    return new Promise(function (resolve) {
      var id = (++seq) + '.' + Math.random().toString(36).slice(2);
      pending[id] = resolve;
      window.dispatchEvent(new CustomEvent('__vgcpk_req', { detail: JSON.stringify({ id: id, op: op, data: data }) }));
    });
  }
  function fail(r) {
    return new DOMException(r.msg || 'Không thực hiện được.', r.err || 'NotAllowedError');
  }
  function abortError() { return new DOMException('The operation was aborted.', 'AbortError'); }

  function hide(o, props) {
    for (var k in props) Object.defineProperty(o, k, { value: props[k], enumerable: false, configurable: true, writable: true });
  }
  function nativeLike(fn, name, len) {
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
    Object.defineProperty(fn, 'length', { value: len, configurable: true });
    Object.defineProperty(fn, 'toString', {
      value: function toString() { return 'function ' + name + '() { [native code] }'; }, configurable: true, writable: true
    });
    return fn;
  }

  var TRANSPORTS = ['internal', 'hybrid'];
  function buildAttestation(d) {
    var resp = Object.create(window.AuthenticatorAttestationResponse ? window.AuthenticatorAttestationResponse.prototype : Object.prototype);
    hide(resp, {
      clientDataJSON: fromB64u(d.clientDataJSON),
      attestationObject: fromB64u(d.attestationObject),
      getTransports: function getTransports() { return TRANSPORTS.slice(); },
      getAuthenticatorData: function getAuthenticatorData() { return fromB64u(d.authData); },
      getPublicKey: function getPublicKey() { return fromB64u(d.publicKey); },
      getPublicKeyAlgorithm: function getPublicKeyAlgorithm() { return -7; }
    });
    var c = Object.create(PKC.prototype);
    hide(c, {
      id: d.id, rawId: fromB64u(d.id), type: 'public-key', authenticatorAttachment: 'platform', response: resp,
      getClientExtensionResults: function getClientExtensionResults() { return {}; },
      toJSON: function toJSON() {
        return {
          id: d.id, rawId: d.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
          response: {
            clientDataJSON: d.clientDataJSON, attestationObject: d.attestationObject, transports: TRANSPORTS.slice(),
            publicKeyAlgorithm: -7, publicKey: d.publicKey, authenticatorData: d.authData
          }
        };
      }
    });
    return c;
  }
  function buildAssertion(d) {
    var resp = Object.create(window.AuthenticatorAssertionResponse ? window.AuthenticatorAssertionResponse.prototype : Object.prototype);
    hide(resp, {
      clientDataJSON: fromB64u(d.clientDataJSON),
      authenticatorData: fromB64u(d.authenticatorData),
      signature: fromB64u(d.signature),
      userHandle: fromB64u(d.userHandle)
    });
    var c = Object.create(PKC.prototype);
    hide(c, {
      id: d.id, rawId: fromB64u(d.id), type: 'public-key', authenticatorAttachment: 'platform', response: resp,
      getClientExtensionResults: function getClientExtensionResults() { return {}; },
      toJSON: function toJSON() {
        return {
          id: d.id, rawId: d.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
          response: { clientDataJSON: d.clientDataJSON, authenticatorData: d.authenticatorData, signature: d.signature, userHandle: d.userHandle }
        };
      }
    });
    return c;
  }

  function waitAutofillFocus(signal) {
    return new Promise(function (resolve, reject) {
      function isTarget(el) {
        return !!(el && el.getAttribute && /webauthn/i.test(el.getAttribute('autocomplete') || ''));
      }
      function cleanup() {
        document.removeEventListener('focusin', onEv, true);
        document.removeEventListener('click', onEv, true);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function onEv(e) { if (isTarget(e.target)) { cleanup(); resolve(); } }
      function onAbort() { cleanup(); reject(abortError()); }
      document.addEventListener('focusin', onEv, true);
      document.addEventListener('click', onEv, true);
      if (signal) signal.addEventListener('abort', onAbort);
      if (isTarget(document.activeElement)) { cleanup(); resolve(); }
    });
  }

  var create = nativeLike(function create(options) {
    var pk = options && options.publicKey;
    if (!pk) return origCreate.apply(this, arguments);
    if (options.signal && options.signal.aborted) return Promise.reject(abortError());
    var user = pk.user || {};
    return call('create', {
      rpId: pk.rp && pk.rp.id,
      challenge: toB64u(pk.challenge),
      user: { id: toB64u(user.id), name: user.name, displayName: user.displayName },
      excludeIds: (pk.excludeCredentials || []).map(function (c) { return toB64u(c.id); }),
      algs: (pk.pubKeyCredParams || []).map(function (p) { return p.alg; })
    }).then(function (r) {
      if (!r.ok) throw fail(r);
      return buildAttestation(r.data);
    });
  }, 'create', 0);

  var get = nativeLike(function get(options) {
    var pk = options && options.publicKey;
    if (!pk) return origGet.apply(this, arguments);
    var signal = options.signal;
    if (signal && signal.aborted) return Promise.reject(abortError());
    var allowIds = (pk.allowCredentials || []).map(function (c) { return toB64u(c.id); });
    var base = { rpId: pk.rpId, challenge: toB64u(pk.challenge), allowIds: allowIds };
    function doGet() {
      return call('get', base).then(function (r) {
        if (!r.ok) throw fail(r);
        return buildAssertion(r.data);
      });
    }
    if (options.mediation === 'conditional') {
      // Như trình duyệt thật: chỉ trả passkey khi người dùng bấm vào ô đăng nhập có autocomplete=webauthn.
      return call('has', { rpId: pk.rpId, allowIds: allowIds }).then(function (h) {
        var never = new Promise(function (_res, rej) {
          if (signal) signal.addEventListener('abort', function () { rej(abortError()); });
        });
        if (!h.ok || !h.data) return never;
        return waitAutofillFocus(signal).then(doGet);
      });
    }
    return doGet();
  }, 'get', 0);

  Object.defineProperty(CC.prototype, 'create', { value: create, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(CC.prototype, 'get', { value: get, writable: true, configurable: true, enumerable: true });

  function setStatic(name, fn, len) {
    Object.defineProperty(PKC, name, { value: nativeLike(fn, name, len), writable: true, configurable: true, enumerable: true });
  }
  setStatic('isUserVerifyingPlatformAuthenticatorAvailable', function isUserVerifyingPlatformAuthenticatorAvailable() { return Promise.resolve(true); }, 0);
  setStatic('isConditionalMediationAvailable', function isConditionalMediationAvailable() { return Promise.resolve(true); }, 0);
  setStatic('getClientCapabilities', function getClientCapabilities() {
    return Promise.resolve({
      conditionalCreate: false, conditionalGet: true, hybridTransport: false, passkeyPlatformAuthenticator: true,
      relatedOrigins: false, signalAllAcceptedCredentials: false, signalCurrentUserDetails: false,
      signalUnknownCredential: false, userVerifyingPlatformAuthenticator: true
    });
  }, 0);
})();
`

/**
 * Ghi extension passkey vào thư mục profile và trả đường dẫn để --load-extension.
 * Trả null nếu không dựng được máy chủ cục bộ (không chặn việc mở profile).
 */
export async function ensurePasskeyExtension(userDataDir: string, profileId: string): Promise<string | null> {
  try {
    const port = await ensureServer()
    const token = tokenFor(profileId)
    const dir = join(userDataDir, 'vgc-passkey-ext')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (name: string, content: string): void =>
      writeFileSync(join(dir, name), content, { encoding: 'utf8', mode: 0o600 })
    write('manifest.json', MANIFEST)
    write('config.js', `var VGC = ${JSON.stringify({ port, token })};\n`)
    write('background.js', BACKGROUND_JS)
    write('isolated.js', ISOLATED_JS)
    write('main.js', MAIN_JS)
    return dir
  } catch {
    return null
  }
}
