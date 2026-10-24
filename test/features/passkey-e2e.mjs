// E2E passkey: trình duyệt VGC thật + extension thật (sinh bởi passkey-ext.ts) + máy chủ WebAuthn
// chuẩn (SimpleWebAuthn) đóng vai trang web. RP tự xác minh attestation / chữ ký.
import { createRequire } from 'module'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, execSync } from 'child_process'
import { randomUUID } from 'crypto'

const require = createRequire(import.meta.url)
const here = import.meta.dirname
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ud-'))
process.env.PK_UD = UD
const PROFILE = randomUUID()
const mod = require('./bundle.cjs')
const sw = await import('@simplewebauthn/server')

const out = { steps: [], fails: [] }
const check = (name, cond, extra) => { out.steps.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); if (!cond) out.fails.push(name) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let RP_PORT = 0
const state = { creds: [], challenge: '' }
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => res(b ? JSON.parse(b) : {})) })
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
const PAGE = `<!doctype html><meta charset=utf-8><title>RP</title><input id="u" autocomplete="username webauthn"><script>
const post = (u, b) => fetch(u, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b)}).then(r => r.json());
async function register() {
  const opts = await (await fetch('/reg/options')).json();
  try {
    const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts) });
    return { ok: true, instance: cred instanceof PublicKeyCredential, verify: await post('/reg/verify', cred.toJSON()),
      hasGetPublicKey: typeof cred.response.getPublicKey === 'function', transports: cred.response.getTransports() };
  } catch (e) { return { ok: false, name: e.name, msg: e.message }; }
}
async function auth() {
  const opts = await (await fetch('/auth/options')).json();
  try {
    const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts) });
    return { ok: true, instance: cred instanceof PublicKeyCredential, verify: await post('/auth/verify', cred.toJSON()) };
  } catch (e) { return { ok: false, name: e.name, msg: e.message }; }
}
async function startConditional() {
  const opts = await (await fetch('/auth/options')).json();
  window.__cond = { done: false };
  window.__ctl = new AbortController();
  navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts), mediation: 'conditional', signal: window.__ctl.signal })
    .then(async (c) => { window.__cond = { done: true, ok: true, verify: await post('/auth/verify', c.toJSON()) } },
          (e) => { window.__cond = { done: true, ok: false, name: e.name } });
  return true;
}
</script>`
const rp = http.createServer(async (req, res) => {
  const origin = 'http://localhost:' + RP_PORT
  try {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE) }
    if (req.url === '/reg/options') {
      const o = await sw.generateRegistrationOptions({ rpName: 'Test RP', rpID: 'localhost', userName: 'alice@example.com', userDisplayName: 'Alice',
        attestationType: 'none', excludeCredentials: state.creds.map((c) => ({ id: c.id })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
      state.challenge = o.challenge; return json(res, o)
    }
    if (req.url === '/reg/verify') {
      const body = await readBody(req)
      const v = await sw.verifyRegistrationResponse({ response: body, expectedChallenge: state.challenge, expectedOrigin: origin, expectedRPID: 'localhost', requireUserVerification: true })
      if (v.verified) state.creds.push({ id: v.registrationInfo.credential.id, publicKey: v.registrationInfo.credential.publicKey, counter: v.registrationInfo.credential.counter, transports: body.response.transports })
      return json(res, { verified: v.verified, backedUp: v.registrationInfo && v.registrationInfo.credentialBackedUp, deviceType: v.registrationInfo && v.registrationInfo.credentialDeviceType })
    }
    if (req.url === '/auth/options') {
      const o = await sw.generateAuthenticationOptions({ rpID: 'localhost', userVerification: 'required', allowCredentials: [] })
      state.challenge = o.challenge; return json(res, o)
    }
    if (req.url === '/auth/verify') {
      const body = await readBody(req)
      const cred = state.creds.find((c) => c.id === body.id)
      if (!cred) return json(res, { verified: false, why: 'unknown credential' })
      const v = await sw.verifyAuthenticationResponse({ response: body, expectedChallenge: state.challenge, expectedOrigin: origin, expectedRPID: 'localhost', credential: cred, requireUserVerification: true })
      return json(res, { verified: v.verified, newCounter: v.authenticationInfo.newCounter })
    }
    res.writeHead(404); res.end()
  } catch (e) { json(res, { verified: false, error: String(e.message || e) }) }
})
await new Promise((r) => rp.listen(0, '127.0.0.1', r))
RP_PORT = rp.address().port

const extDir = await mod.ensurePasskeyExtension(path.join(UD, 'prof'), PROFILE)
check('ensurePasskeyExtension ghi duoc extension', !!extDir && fs.existsSync(path.join(extDir, 'main.js')), extDir)
const eng = process.env.VGC_ENGINE || path.join(here, '..', '..', 'engine', 'chromium', 'chrome.exe')
const udBrowser = path.join(UD, 'browser')
const DBG = 9444
const proc = spawn(eng, ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + udBrowser, '--load-extension=' + extDir, '--disable-extensions-except=' + extDir, '--disable-features=ExtensionDisableUnsupportedDeveloper', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

async function cdpPage(url) {
  for (let i = 0; i < 40; i++) { try { await (await fetch('http://127.0.0.1:' + DBG + '/json/version')).json(); break } catch { await sleep(500) } }
  const t = await (await fetch('http://127.0.0.1:' + DBG + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0; const pend = {}
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d) }
  const send = (method, params) => new Promise((res) => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expr) => { const d = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); return d.result.exceptionDetails ? { __err: d.result.exceptionDetails.exception && d.result.exceptionDetails.exception.description } : d.result.result.value }
  return { ev }
}

try {
  const { ev } = await cdpPage('http://localhost:' + RP_PORT + '/')
  await sleep(1500)
  check('shim da cai (create giong ban goc)', (await ev('navigator.credentials.create.toString()')) === 'function create() { [native code] }')
  check('isUserVerifyingPlatformAuthenticatorAvailable = true', (await ev('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()')) === true)
  check('isConditionalMediationAvailable = true', (await ev('PublicKeyCredential.isConditionalMediationAvailable()')) === true)

  const reg = await ev('register()')
  check('DANG KY passkey: RP xac minh attestation hop le', reg && reg.ok && reg.verify && reg.verify.verified === true, reg)
  check('doi tuong tra ve la instanceof PublicKeyCredential', reg && reg.instance === true)
  check('co getPublicKey() va transports', reg && reg.hasGetPublicKey === true && Array.isArray(reg.transports))
  check('RP thay passkey multiDevice + da sao luu (BE/BS)', reg && reg.verify && reg.verify.deviceType === 'multiDevice' && reg.verify.backedUp === true)

  const list = await mod.listPasskeys(PROFILE)
  check('kho co 1 passkey cho localhost', list.length === 1 && list[0].rpId === 'localhost' && list[0].userName === 'alice@example.com', list)
  const raw = fs.readFileSync(path.join(UD, 'profiles', PROFILE, 'Default', 'vgc-passkeys.enc'))
  check('file kho MA HOA (khong lo khoa rieng)', raw.subarray(0, 7).toString('latin1') === 'VGCENC1' && !raw.toString('latin1').includes('pkcs8') && !raw.toString('latin1').includes('alice'))

  const au = await ev('auth()')
  check('DANG NHAP passkey: RP xac minh chu ky hop le', au && au.ok && au.verify && au.verify.verified === true, au)
  const dup = await ev('register()')
  check('dang ky trung (excludeCredentials) -> InvalidStateError', dup && dup.ok === false && dup.name === 'InvalidStateError', dup)

  await ev('startConditional()')
  await sleep(1000)
  check('conditional: CHUA tra ket qua khi chua bam o dang nhap', (await ev('window.__cond.done')) === false)
  await ev("(function(){ var u=document.getElementById('u'); u.focus(); u.click(); return true })()")
  await sleep(2500)
  const cond = await ev('window.__cond')
  check('conditional: bam o webauthn -> dang nhap xac minh hop le', cond && cond.done && cond.ok && cond.verify && cond.verify.verified === true, cond)

  const evil = await ev("navigator.credentials.get({publicKey:{challenge:new Uint8Array(32), rpId:'evil.com'}}).then(()=> 'OPENED', e=>e.name)")
  check('rpId khong thuoc trang -> SecurityError', evil === 'SecurityError', evil)
  const pw = await ev("(function(){ try { var p = navigator.credentials.get({password:true}); return typeof p.then === 'function' ? 'promise' : 'other' } catch(e){ return 'THROW ' + e.name } })()")
  check('credentials khong phai WebAuthn van di duong goc', pw === 'promise', pw)

  check('xoa passkey thanh cong', (await mod.deletePasskey(PROFILE, list[0].id)) === true && (await mod.listPasskeys(PROFILE)).length === 0)
  const afterDel = await ev('auth()')
  check('sau khi xoa: dang nhap bi tu choi', afterDel && afterDel.ok === false && afterDel.name === 'NotAllowedError', afterDel)
} catch (e) {
  out.error = String(e && e.stack || e)
} finally {
  try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }) } catch {}
  rp.close()
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.fails.length || out.error ? 1 : 0)
}
