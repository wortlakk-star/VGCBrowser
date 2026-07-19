// ── VGC Browser — bulk Gmail password changer ────────────────────────────────
// Drives Google's own "change password" web flow INSIDE a profile so the account
// keeps its usual proxy + native fingerprint (the only way Google won't flag the
// change as coming from a new/foreign environment).
//
// Control channel: the profile is launched in `automation` mode (a real CDP debug
// PORT on the native engine — see launchProfile). We attach our OWN minimal control
// connection and drive the page with `Runtime.evaluate` + `Input` ONLY. We never
// call `Runtime.enable`, so navigator.webdriver stays false and the automation
// footprint is tiny.
//
// ⚠️ Google actively fights automation and its DOM/flow + Vietnamese/English wording
// change over time. All the FRAGILE, provider-specific logic lives in ONE place —
// `BRAIN` below — so it's easy to tune against real accounts. When Google throws a
// 2-step / identity challenge we CANNOT clear it programmatically: the window is
// visible, we keep polling, and the user finishes it by hand (phone tap / code). If
// it isn't cleared within the budget the account is reported `needs_manual`.

import type { CdpConnection } from './cdp'
import { launchProfile, stopProfile, getAutomationConn } from './profile-manager'
import { generateTotp } from './totp'
import { solveImageCaptcha, solveRecaptchaV2 } from './capsolver'
import { getSettings } from './settings'
import { dbg } from './dbg'
import type { GmailPasswordTask, GmailChangeResult, GmailProgress } from '../shared/types'

const CHANGE_URL = 'https://myaccount.google.com/signinoptions/password'

/** Total wall-clock budget per account (includes time the user spends on a live
 *  2FA/identity challenge — a phone tap should land well inside this). */
const TOTAL_BUDGET_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 1500

type BrainState =
  | 'signin_email'
  | 'reauth' // single current-password field (sign-in Passwd OR re-auth)
  | 'totp' // Google Authenticator 2-step code prompt (auto-filled from the secret)
  | 'captcha' // image captcha / reCAPTCHA — needs a solver or manual input
  | 'newpass_form'
  | 'wrong_password'
  | 'no_account' // Google says the email itself doesn't exist (not a password problem)
  | 'weak_password'
  | 'challenge'
  | 'done'
  | 'loading'
  | 'unknown'

interface BrainResult {
  state: BrainState
  url?: string
  detail?: string
  submitted?: boolean
  captchaKind?: 'image' | 'recaptcha' | 'unknown'
  imageB64?: string
  sitekey?: string
}

/** In-page script (built in main) that types a solved image-captcha answer into
 *  the captcha input and submits. Runs via Runtime.evaluate. */
function fillImageCaptchaExpr(text: string): string {
  return `(function (t) {
    function vis(el){return !!el&&el.offsetParent!==null&&!el.disabled;}
    function setVal(el,v){var p=Object.getPrototypeOf(el),d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(el,v);else el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
    var inp=document.querySelector('input[name=ca]')||document.querySelector('input#ca');
    if(!vis(inp)){var c=[].slice.call(document.querySelectorAll('input[type=text],input[type=tel]')).filter(function(e){return vis(e)&&e.type!=='email';});inp=c[0]||null;}
    if(!vis(inp))return false;
    setVal(inp,t);
    var btns=[].slice.call(document.querySelectorAll('button,[role=button],input[type=submit]')).filter(vis);
    for(var i=0;i<btns.length;i++){var x=(btns[i].innerText||btns[i].value||'').toLowerCase();if(x.indexOf('next')!==-1||x.indexOf('tiếp')!==-1||x.indexOf('verify')!==-1||x.indexOf('xác')!==-1||x.indexOf('submit')!==-1||x.indexOf('sign in')!==-1||x.indexOf('đăng nhập')!==-1){btns[i].click();break;}}
    return true;
  })(${JSON.stringify(text)})`
}

/** In-page script that injects a solved reCAPTCHA token + best-effort fires its
 *  callback. reCAPTCHA-via-token is inherently fragile; this is experimental. */
function injectRecaptchaExpr(token: string): string {
  return `(function (tok) {
    var ta=document.querySelector('#g-recaptcha-response')||document.querySelector('textarea[name="g-recaptcha-response"]');
    if(ta){ta.value=tok;ta.style.display='block';ta.dispatchEvent(new Event('input',{bubbles:true}));ta.dispatchEvent(new Event('change',{bubbles:true}));}
    try{
      var cs=window.___grecaptcha_cfg&&window.___grecaptcha_cfg.clients;
      if(cs){for(var k in cs){var cl=cs[k];for(var a in cl){var o=cl[a];if(o&&typeof o.callback==='function'){try{o.callback(tok);}catch(e){}}else if(o){for(var b in o){var oo=o[b];if(oo&&typeof oo.callback==='function'){try{oo.callback(tok);}catch(e){}}}}}}
    }catch(e){}
    return !!ta;
  })(${JSON.stringify(token)})`
}

// The "brain" — runs IN the page each poll. It reads the current DOM, performs the
// single next action for whatever Google is showing, and reports back what it saw.
// Kept as a string so it can be shipped verbatim through Runtime.evaluate. Pure DOM;
// no external deps. TUNE HERE when Google changes its markup/wording.
export const BRAIN = /* js */ `
(function (cfg) {
  // Attaching CDP (even over the pipe) flips navigator.webdriver to TRUE, which Google
  // blocks at sign-in. Re-assert FALSE inline every poll — addScriptToEvaluateOnNewDocument
  // does NOT stick, but this inline define on Navigator.prototype does (verified). Runs
  // right before we fill/submit, so it's false at interaction time.
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: function () { return false; }, configurable: true, enumerable: true }); } catch (e) {}
  var url = location.href;
  var vis = function (el) { return !!el && el.offsetParent !== null && !el.disabled; };
  function setVal(el, val) {
    try {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    } catch (e) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pwFields() {
    return Array.prototype.slice
      .call(document.querySelectorAll('input[type=password]'))
      .filter(vis);
  }
  function clickText(texts) {
    var els = Array.prototype.slice
      .call(document.querySelectorAll('button, [role=button], input[type=submit], div[jsname]'))
      .filter(vis);
    for (var i = 0; i < texts.length; i++) {
      for (var j = 0; j < els.length; j++) {
        var t = (els[j].innerText || els[j].value || '').trim().toLowerCase();
        if (t && t.indexOf(texts[i]) !== -1) { els[j].click(); return true; }
      }
    }
    return false;
  }
  function clickNext() {
    if (clickText(['next', 'tiếp theo', 'tiếp tục', 'continue'])) return true;
    var ids = ['identifierNext', 'passwordNext'];
    for (var k = 0; k < ids.length; k++) {
      var host = document.getElementById(ids[k]);
      if (host) { var b = host.querySelector('button'); if (b) { b.click(); return true; } }
    }
    return false;
  }
  // Gather what an auto-solver (CapSolver) needs: reCAPTCHA sitekey, or the image
  // captcha as base64 PNG (via canvas — Google's captchaimg is same-origin so no taint).
  function captchaInfo() {
    var info = { captchaKind: 'unknown', imageB64: '', sitekey: '' };
    var rc = document.querySelector('[data-sitekey]');
    var sk = rc ? rc.getAttribute('data-sitekey') : '';
    if (!sk) {
      var ifr = document.querySelector('iframe[src*="recaptcha"]');
      if (ifr) { var mm = (ifr.getAttribute('src') || '').match(/[?&]k=([^&]+)/); if (mm) sk = decodeURIComponent(mm[1]); }
    }
    if (sk) { info.captchaKind = 'recaptcha'; info.sitekey = sk; return info; }
    var img = document.querySelector('img#captchaimg') ||
      document.querySelector('img[src*="Captcha"]') ||
      document.querySelector('img[src*="captcha"]');
    if (img) {
      info.captchaKind = 'image';
      try {
        var cv = document.createElement('canvas');
        cv.width = img.naturalWidth || img.width || 200;
        cv.height = img.naturalHeight || img.height || 70;
        cv.getContext('2d').drawImage(img, 0, 0);
        info.imageB64 = (cv.toDataURL('image/png').split(',')[1]) || '';
      } catch (e) { info.imageB64 = ''; }
    }
    return info;
  }

  var body = ((document.body && document.body.innerText) || '').toLowerCase();

  // Captcha present on THIS page (image "type the text" or reCAPTCHA). We can't clear
  // it without a solver service — flag it, but still fill any visible field first so a
  // manual solve on the open window lets the flow continue.
  var hasCaptcha = !!(document.querySelector('img#captchaimg') ||
    document.querySelector('input[name=ca]') ||
    document.querySelector('iframe[src*="recaptcha"]') ||
    document.querySelector('.g-recaptcha')) ||
    body.indexOf("i'm not a robot") !== -1 ||
    body.indexOf('tôi không phải là người máy') !== -1 ||
    body.indexOf('nhập các ký tự bạn nhìn thấy') !== -1 ||
    body.indexOf('type the characters you see') !== -1;

  // Hard error signals first (so we don't mistake them for a normal step).
  // Email-not-found is a DIFFERENT problem from a wrong password — report it separately so the
  // operator fixes the address, not the password.
  if (body.indexOf("couldn't find your google account") !== -1 ||
      body.indexOf('không tìm thấy tài khoản google') !== -1) {
    return { state: 'no_account', url: url };
  }
  if (body.indexOf('wrong password') !== -1 ||
      body.indexOf('mật khẩu không chính xác') !== -1 ||
      body.indexOf('sai mật khẩu') !== -1) {
    return { state: 'wrong_password', url: url };
  }
  if (body.indexOf('choose a stronger password') !== -1 ||
      body.indexOf('mật khẩu mạnh hơn') !== -1 ||
      body.indexOf("can't use your old password") !== -1 ||
      body.indexOf('không thể dùng mật khẩu cũ') !== -1) {
    return { state: 'weak_password', url: url };
  }

  var emailField = document.querySelector('input[type=email]');
  var pf = pwFields();

  // Sign-in: identifier (email) step.
  if (vis(emailField) && pf.length === 0) {
    if (emailField.value.trim().toLowerCase() !== cfg.email.trim().toLowerCase()) setVal(emailField, cfg.email);
    clickNext();
    if (hasCaptcha) { var ci1 = captchaInfo(); return { state: 'captcha', url: url, captchaKind: ci1.captchaKind, imageB64: ci1.imageB64, sitekey: ci1.sitekey }; }
    return { state: 'signin_email', url: url };
  }

  var onChangePath = /signinoptions\\/password|changepassword|EditPasswd/i.test(url);

  // Change-password form: TWO password inputs (new + confirm).
  if (pf.length >= 2) {
    if (pf[0].value !== cfg.newPassword) setVal(pf[0], cfg.newPassword);
    if (pf[1].value !== cfg.newPassword) setVal(pf[1], cfg.newPassword);
    var ok = clickText(['change password', 'đổi mật khẩu', 'save password', 'lưu mật khẩu',
                        'update password', 'cập nhật mật khẩu', 'save', 'lưu']);
    return { state: 'newpass_form', url: url, submitted: ok };
  }

  // Single password field: current-password prompt (sign-in Passwd OR re-auth "xác minh").
  if (pf.length === 1) {
    if (pf[0].value.length === 0) setVal(pf[0], cfg.oldPassword);
    clickNext();
    if (hasCaptcha) { var ci2 = captchaInfo(); return { state: 'captcha', url: url, captchaKind: ci2.captchaKind, imageB64: ci2.imageB64, sitekey: ci2.sitekey }; }
    return { state: 'reauth', url: url };
  }

  // 2-step verification via Google Authenticator. cfg.totp is the CURRENT 6-digit
  // code (regenerated by the main process each poll). Only runs when we actually
  // have a secret — otherwise this is a manual challenge below.
  if (cfg.totp) {
    // Only auto-type the code on a page that clearly IS a code prompt — otherwise a
    // stray numeric/tel input (e.g. a phone-number field) would get the TOTP typed in.
    var looksCode = body.indexOf('authenticator') !== -1 || body.indexOf('xác thực') !== -1 ||
      body.indexOf('2-step') !== -1 || body.indexOf('2 bước') !== -1 ||
      body.indexOf('mã xác minh') !== -1 || body.indexOf('verification code') !== -1 ||
      body.indexOf('enter the code') !== -1 || body.indexOf('nhập mã') !== -1 ||
      body.indexOf('2fa') !== -1;
    // Specific selectors are trustworthy on their own; the generic numeric/text
    // fallbacks are used ONLY when the page text confirms a code prompt.
    var codeInput = document.querySelector('input#totpPin, input[name=totpPin], input[autocomplete=one-time-code]');
    if (!vis(codeInput) && looksCode) {
      var numeric = Array.prototype.slice
        .call(document.querySelectorAll('input[type=tel], input[type=number], input[inputmode=numeric]'))
        .filter(vis);
      codeInput = numeric.length ? numeric[0] : null;
      if (!vis(codeInput)) {
        var texts = Array.prototype.slice
          .call(document.querySelectorAll('input[type=text]'))
          .filter(function (el) { return vis(el) && el.type !== 'email'; });
        codeInput = texts.length ? texts[0] : null;
      }
    }
    if (vis(codeInput)) {
      var cur = (codeInput.value || '').replace(/\\D/g, '');
      // Submit ONLY when a new code was actually typed. clickNext() previously fired on every
      // ~1.5s poll even though the code is constant within a 30s window — ~200 resubmissions of a
      // failed 2FA code across the budget, which gets the account rate-limited / locked. Now it
      // fires ~once per 30s window (when the rotating code changes).
      if (cur !== cfg.totp) { setVal(codeInput, cfg.totp); clickNext(); }
      return { state: 'totp', url: url };
    }
    // Google defaulted to the phone-tap prompt: steer toward the Authenticator option.
    if (body.indexOf('try another way') !== -1 || body.indexOf('thử cách khác') !== -1) {
      clickText(['try another way', 'thử cách khác']);
      return { state: 'totp', url: url, detail: 'another-way' };
    }
    if (clickText(['google authenticator', 'authenticator', 'trình xác thực', 'ứng dụng xác thực'])) {
      return { state: 'totp', url: url, detail: 'pick-authenticator' };
    }
  }

  // Success heuristic: back on a plain account page with no password fields.
  if (/myaccount\\.google\\.com\\/(security|home|personal-info|\\?|#|$)/.test(url) && pf.length === 0 && !vis(emailField)) {
    return { state: 'done', url: url };
  }

  // A page that is ONLY a captcha (nothing else actionable) → report it.
  if (hasCaptcha) {
    var ci3 = captchaInfo();
    return { state: 'captcha', url: url, captchaKind: ci3.captchaKind, imageB64: ci3.imageB64, sitekey: ci3.sitekey };
  }

  // Identity / 2-step / captcha challenge we can't clear automatically.
  var markers = ['2-step', '2 bước', 'xác minh danh tính', "verify it's you", 'verify its you',
    'confirm your recovery', 'khôi phục', 'mã xác minh', 'enter the code', 'nhập mã',
    'unusual activity', 'hoạt động bất thường', 'captcha', 'get a verification code',
    'lấy mã xác minh', 'try another way', 'thử cách khác'];
  for (var m = 0; m < markers.length; m++) {
    if (body.indexOf(markers[m]) !== -1) return { state: 'challenge', url: url, detail: markers[m] };
  }

  if (body.length < 5) return { state: 'loading', url: url };
  return { state: 'unknown', url: url };
})(__CFG__)
`

export function phaseMessage(state: BrainState): string {
  switch (state) {
    case 'signin_email':
      return 'Đang đăng nhập (nhập email)…'
    case 'reauth':
      return 'Đang nhập mật khẩu hiện tại…'
    case 'totp':
      return 'Đang nhập mã 2FA (Authenticator)…'
    case 'captcha':
      return '⚠️ Dính captcha — giải trên cửa sổ đang mở'
    case 'newpass_form':
      return 'Đang đặt mật khẩu mới…'
    case 'challenge':
      return '⚠️ Google yêu cầu xác minh — hãy xác minh trên cửa sổ đang mở'
    case 'wrong_password':
      return 'Mật khẩu cũ không đúng'
    case 'weak_password':
      return 'Google từ chối mật khẩu mới (yếu/trùng cũ)'
    case 'done':
      return 'Đã đổi mật khẩu ✓'
    case 'loading':
      return 'Đang tải trang…'
    default:
      return 'Đang xử lý…'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Attach to the profile's first page target and return a driver bound to its
 *  session. Same-tab navigations keep the session valid (flatten routing). */
export async function attachPage(
  conn: CdpConnection
): Promise<{ evaluate: (expr: string) => Promise<unknown>; navigate: (url: string) => Promise<void> }> {
  // Follow the LIVE page session. Google's flow does cross-process navigations (the initial
  // page → accounts.google.com → myaccount.google.com); each one DETACHES the current
  // session and ATTACHES a new one. The old code cached ONE sessionId, so every later
  // Runtime.evaluate failed with "Session with given id not found" and the flow never drove
  // the page (the password was never changed). We track attach/detach events AND re-resolve
  // the page session on demand so a dead session is always replaced by the live one.
  let sessionId = ''
  conn.on('Target.attachedToTarget', (params) => {
    const ti = params.targetInfo as { type?: string } | undefined
    if (ti?.type === 'page' && typeof params.sessionId === 'string') sessionId = params.sessionId
  })
  conn.on('Target.detachedFromTarget', (params) => {
    if (typeof params.sessionId === 'string' && params.sessionId === sessionId) sessionId = ''
  })

  const resolvePage = async (): Promise<void> => {
    const { targetInfos } = (await conn.send('Target.getTargets')) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string }>
    }
    const page = (targetInfos ?? []).find((t) => t.type === 'page')
    if (!page) return
    const r = (await conn.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true
    })) as { sessionId?: string }
    if (r.sessionId) sessionId = r.sessionId
  }

  await conn.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  })

  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !sessionId) {
    await resolvePage()
    if (!sessionId) await sleep(300)
  }
  if (!sessionId) throw new Error('Không tìm thấy tab để điều khiển (CDP)')

  const evaluate = async (expr: string): Promise<unknown> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!sessionId) {
        await resolvePage()
        if (!sessionId) {
          await sleep(300)
          continue
        }
      }
      try {
        const r = (await conn.send(
          'Runtime.evaluate',
          { expression: expr, returnByValue: true, awaitPromise: false },
          sessionId
        )) as { result?: { value?: unknown }; exceptionDetails?: unknown }
        if (r.exceptionDetails) return undefined
        return r.result?.value
      } catch (e) {
        // Session died (a navigation swapped the tab's renderer process) — drop it and
        // re-resolve the live page session, then retry. Non-session errors propagate.
        if (/session with given id not found|no session|target closed|not found/i.test(String(e))) {
          sessionId = ''
          await resolvePage()
          continue
        }
        throw e
      }
    }
    return undefined
  }
  const navigate = async (url: string): Promise<void> => {
    await evaluate(`location.href=${JSON.stringify(url)}`)
  }
  return { evaluate, navigate }
}

/**
 * Change one Gmail account's password by driving Google's web flow inside its
 * profile. Emits live progress; leaves the window visible so the user can clear a
 * 2FA/identity challenge by hand. The profile is stopped when the account is done
 * (success or terminal failure) so a batch can move to the next one.
 */
export async function changeGmailPassword(
  profileId: string,
  task: GmailPasswordTask,
  onProgress: (p: GmailProgress) => void
): Promise<GmailChangeResult> {
  const emit = (phase: string, message: string): void =>
    onProgress({ profileId, email: task.email, phase, message })

  emit('launch', 'Đang mở profile…')
  let conn: CdpConnection | null = null
  try {
    // launchProfile with automation:true force-relaunches an already-open profile so we
    // get a control pipe (see the guard in profile-manager). Then grab that connection.
    await launchProfile(profileId, { automation: true })
    conn = getAutomationConn(profileId)
    if (!conn) throw new Error('Không mở được kênh điều khiển (CDP pipe)')
    const page = await attachPage(conn)

    // Give the freshly-spawned engine a moment, then make sure we're on the change-
    // password page (the launch lands here, but a full sign-in can bounce elsewhere).
    await sleep(800)

    // Make sure we're on the change-password page (the launch lands here, but a full
    // sign-in can bounce us to the account home first).
    await page.navigate(CHANGE_URL)

    const secret = task.totpSecret?.trim()
    const capsolverKey = (await getSettings()).capsolverApiKey?.trim() || ''

    const deadline = Date.now() + TOTAL_BUDGET_MS
    let lastState: BrainState | null = null
    let sawSubmit = false
    let lastNavAt = Date.now()
    // The image/sitekey we've already sent to CapSolver — so we solve each distinct
    // captcha ONCE (not every 1.5s poll). A refreshed image → new key → solve again.
    let captchaHandledKey = ''

    while (Date.now() < deadline) {
      // Rebuild each poll so the injected TOTP code is always the CURRENT one (it
      // rolls over every 30s). The secret itself never reaches the page.
      const cfg = JSON.stringify({
        email: task.email,
        oldPassword: task.oldPassword,
        newPassword: task.newPassword,
        totp: secret ? generateTotp(secret) : ''
      })
      // split/join, NOT replace(): String.replace treats $$, $&, $`, $' in the
      // replacement as special, which would CORRUPT any password containing '$'
      // (typing a different password than we record → account lockout).
      const expr = BRAIN.split('__CFG__').join(cfg)

      let res: BrainResult
      try {
        res = ((await page.evaluate(expr)) as BrainResult) ?? { state: 'loading' }
      } catch (err) {
        dbg(`[gmail ${task.email}] evaluate error: ${String(err)}`)
        res = { state: 'loading' }
      }
      if (res.submitted) sawSubmit = true

      if (res.state !== lastState) {
        lastState = res.state
        emit(res.state, phaseMessage(res.state))
      }

      switch (res.state) {
        case 'done':
          // Only trust 'done' once we've actually submitted the new password (the
          // account-home heuristic could otherwise match before we did anything).
          if (sawSubmit) {
            stopProfile(profileId)
            return { email: task.email, profileId, status: 'done', message: 'Đã đổi mật khẩu thành công' }
          }
          // Landed on the account home/security page BEFORE submitting (e.g. a full
          // sign-in hop) — NOT actually done. Nudge back to the change-password page
          // so we don't stall the whole budget here.
          if (Date.now() - lastNavAt > 6000) {
            await page.navigate(CHANGE_URL)
            lastNavAt = Date.now()
          }
          break
        case 'no_account':
          stopProfile(profileId)
          return {
            email: task.email,
            profileId,
            status: 'needs_manual',
            message: 'Không tìm thấy tài khoản Google — kiểm tra lại email'
          }
        case 'wrong_password':
          stopProfile(profileId)
          return {
            email: task.email,
            profileId,
            status: 'wrong_password',
            message: 'Mật khẩu cũ không đúng — không đổi được'
          }
        case 'weak_password':
          // Recoverable in principle, but we can't invent a new password → report.
          stopProfile(profileId)
          return {
            email: task.email,
            profileId,
            status: 'weak_password',
            message: 'Google từ chối mật khẩu mới (quá yếu hoặc trùng mật khẩu cũ)'
          }
        case 'captcha':
          // Auto-solve via CapSolver when a key is set — otherwise the window stays
          // open for a manual solve and we just keep polling.
          if (capsolverKey) {
            const kind = res.captchaKind
            if (kind === 'image' && res.imageB64 && res.imageB64 !== captchaHandledKey) {
              emit('captcha', 'Đang giải captcha ảnh (CapSolver)…')
              captchaHandledKey = res.imageB64
              const text = await solveImageCaptcha(capsolverKey, res.imageB64)
              if (text) {
                await page.evaluate(fillImageCaptchaExpr(text))
                emit('captcha', `Đã điền captcha "${text}"`)
              } else {
                emit('captcha', 'CapSolver không giải được captcha ảnh')
              }
            } else if (kind === 'recaptcha' && res.sitekey && res.sitekey !== captchaHandledKey) {
              emit('captcha', 'Đang giải reCAPTCHA (CapSolver)…')
              captchaHandledKey = res.sitekey
              const token = await solveRecaptchaV2(capsolverKey, res.url || CHANGE_URL, res.sitekey)
              if (token) {
                await page.evaluate(injectRecaptchaExpr(token))
                emit('captcha', 'Đã nạp token reCAPTCHA')
              } else {
                emit('captcha', 'CapSolver không giải được reCAPTCHA')
              }
            }
          }
          break
        case 'unknown':
          // Drifted off the flow (e.g. landed on account home after a full sign-in).
          // Nudge back to the change page, at most every 6s.
          if (!sawSubmit && Date.now() - lastNavAt > 6000) {
            await page.navigate(CHANGE_URL)
            lastNavAt = Date.now()
          }
          break
        default:
          break
      }

      await sleep(POLL_INTERVAL_MS)
    }

    // Budget exhausted without a confirmed change.
    stopProfile(profileId)
    if (lastState === 'captcha') {
      return {
        email: task.email,
        profileId,
        status: 'captcha',
        message: 'Dính captcha — giải thủ công (hoặc nối dịch vụ giải captcha) rồi thử lại'
      }
    }
    return {
      email: task.email,
      profileId,
      status: 'needs_manual',
      message:
        lastState === 'challenge'
          ? 'Cần xác minh 2 bước/danh tính — hãy làm thủ công rồi thử lại'
          : 'Hết thời gian chờ — kiểm tra & đổi thủ công'
    }
  } catch (err) {
    try {
      stopProfile(profileId)
    } catch {
      // ignore
    }
    return {
      email: task.email,
      profileId,
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    try {
      conn?.close()
    } catch {
      // ignore
    }
  }
}
