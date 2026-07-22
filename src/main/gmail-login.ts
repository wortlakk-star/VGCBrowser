// ── VGC Browser — auto sign-in to Gmail (login-only) ─────────────────────────
// Reuses the Gmail automation "brain" from gmail-password.ts — it already drives the
// email → password → 2FA steps — but STOPS as soon as the account home is reached
// (brain state 'done'); it never navigates to the change-password page or touches the
// password. The profile is left signed-in (session persisted on disk) and the account is
// marked live / die / needs_manual.
import type { CdpConnection } from './cdp'
import type { GmailProgress, GmailLoginResult } from '../shared/types'
import { launchProfile, stopProfile, getAutomationConn } from './profile-manager'
import { generateTotp } from './totp'
import { attachPage, BRAIN } from './gmail-password'
import { dbg } from './dbg'

// Sign IN here, not myaccount.google.com/: when the profile is signed OUT, myaccount.google.com/
// 302s to the public marketing page (www.google.com/account/about) — NO sign-in form — so the
// brain would see nothing to type and the login would hang doing nothing. accounts.google.com/
// lands on the real v3/signin/identifier form when signed out, and (harmlessly) redirects to the
// myaccount home when already signed in — which the brain's success heuristic still matches.
const HOME_URL = 'https://accounts.google.com/'
const LOGIN_BUDGET_MS = 120000 // 2 min per account

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const PHASE_MSG: Record<string, string> = {
  launch: 'Đang mở profile…',
  signin_email: 'Đang nhập email…',
  reauth: 'Đang nhập mật khẩu…',
  totp: 'Đang nhập mã 2FA…',
  chooser: 'Đang chọn tài khoản…',
  challenge: '⚠️ Google yêu cầu xác minh — hãy xác minh trên cửa sổ đang mở',
  captcha: '⚠️ Gặp captcha — hãy giải trên cửa sổ đang mở',
  loading: 'Đang tải…'
}

export interface GmailLoginTask {
  email: string
  password: string
  totpSecret?: string
}

/** Sign a single profile into Gmail using its stored creds. Never throws — returns a result. */
export async function gmailLogin(
  profileId: string,
  task: GmailLoginTask,
  onProgress: (p: GmailProgress) => void
): Promise<GmailLoginResult> {
  const done = (status: GmailLoginResult['status'], message: string): GmailLoginResult => {
    dbg(`[gmail-login ${task.email}] DONE status=${status} — ${message}`)
    try {
      stopProfile(profileId)
    } catch {
      /* ignore */
    }
    return { profileId, email: task.email, status, message }
  }
  const emit = (phase: string, message: string): void => {
    try {
      onProgress({ profileId, email: task.email, phase, message })
    } catch {
      /* a throwing progress callback must never break the login */
    }
  }

  emit('launch', PHASE_MSG.launch)
  dbg(`[gmail-login ${task.email}] start (profile ${profileId})`)
  try {
    await launchProfile(profileId, { automation: true })
    const conn: CdpConnection | null = getAutomationConn(profileId)
    dbg(`[gmail-login ${task.email}] launched — automationConn=${conn ? 'ok' : 'NULL'}`)
    if (!conn) throw new Error('Không mở được kênh điều khiển (CDP pipe)')
    const page = await attachPage(conn)
    dbg(`[gmail-login ${task.email}] attached; navigating to account home`)
    await sleep(800)
    await page.navigate(HOME_URL)
    // Let the (possibly redirecting) page settle before the first brain poll, so we read the
    // real landing page — account home if signed-in, the sign-in identifier page if not — and
    // not a transient about:blank / mid-redirect state.
    await sleep(2500)
    dbg(
      `[gmail-login ${task.email}] landed at ${String(
        (await page.evaluate('location.href').catch(() => '?')) || '?'
      )}`
    )

    const secret = task.totpSecret?.trim()
    const deadline = Date.now() + LOGIN_BUDGET_MS
    let last = ''
    // Did we ever observe a REAL sign-in step (email typed, password typed, 2FA, account picked,
    // or a challenge)? 'done' is only trustworthy as a genuine login once a step happened, OR
    // when it persists (an already-signed-in session stays 'done'; a still-loading account shell
    // whose URL momentarily matches the success regex does not). This blocks a false "live".
    let sawStep = false
    let doneStreak = 0
    // The residential proxy sometimes fails to load accounts.google.com on the first hit
    // (net error → chrome-error page). Without a retry the brain just sees an unactionable page
    // and burns the whole 2-min budget doing nothing (that's the bulk-import "đứng"). Re-navigate
    // a few times — a flaky proxy usually loads on the 2nd/3rd try.
    let navRetries = 0
    let lastNavAt = Date.now()
    while (Date.now() < deadline) {
      // Rebuild each poll so the injected TOTP is the CURRENT code. newPassword is '' — the
      // change-password (two-field) branch of the brain never fires in loginOnly mode, so login
      // never mutates anything; it only signs in.
      const cfg = JSON.stringify({
        email: task.email,
        oldPassword: task.password,
        newPassword: '',
        totp: secret ? generateTotp(secret) : '',
        loginOnly: true // never type/submit into a NEW-password (change) form — sign-in only
      })
      const expr = BRAIN.split('__CFG__').join(cfg)
      let res: { state: string; detail?: string }
      try {
        res = ((await page.evaluate(expr)) as { state: string; detail?: string }) ?? { state: 'loading' }
      } catch (e) {
        dbg(`[gmail-login ${task.email}] eval error: ${String(e)}`)
        res = { state: 'loading' }
      }
      if (res.state !== last) {
        last = res.state
        dbg(`[gmail-login ${task.email}] state=${res.state}${res.detail ? ` (${res.detail})` : ''}`)
        emit(res.state, PHASE_MSG[res.state] ?? res.state)
      }
      if (
        res.state === 'signin_email' ||
        res.state === 'reauth' ||
        res.state === 'totp' ||
        res.state === 'chooser' ||
        res.state === 'challenge' ||
        res.state === 'captcha'
      ) {
        sawStep = true
      }
      if (res.state !== 'done') doneStreak = 0

      // Page failed to load (proxy/net error) → chrome-error / blank. Re-navigate to retry
      // instead of wasting the budget polling a dead page.
      if ((res.state === 'unknown' || res.state === 'loading') && navRetries < 4 && Date.now() - lastNavAt > 6000) {
        const url = String((await page.evaluate('location.href').catch(() => '')) || '')
        if (/^chrome-error:|chromewebdata|^about:blank$|^data:/.test(url)) {
          navRetries++
          lastNavAt = Date.now()
          dbg(`[gmail-login ${task.email}] load failed (${url}) — re-navigate retry ${navRetries}`)
          await page.navigate(HOME_URL)
          await sleep(2500)
          continue
        }
      }

      switch (res.state) {
        case 'done':
          // We drove an actual sign-in → definitely live. Otherwise this is an already-signed-in
          // session (or a transient) — trust it only once 'done' persists across two polls so a
          // still-loading shell can't be misread as a completed login.
          if (sawStep) return done('live', 'Đăng nhập thành công')
          if (++doneStreak >= 2) return done('live', 'Đã đăng nhập sẵn')
          break
        case 'newpass_form':
        case 'weak_password':
          // Google is FORCING a change/create-password page — NOT a normal signed-in home. In
          // login-only mode the brain neither types nor submits here (cfg.loginOnly); we surface
          // it for manual handling instead of falsely reporting a successful login.
          return done('needs_manual', 'Tài khoản bị buộc đổi/tạo mật khẩu — xử lý tay')
        case 'no_account':
          return done('die', 'Không tìm thấy tài khoản Google')
        case 'wrong_password':
          return done('die', 'Sai mật khẩu')
        // captcha / challenge are NOT terminal: the automation window is VISIBLE, so keep polling
        // within the budget — the user (or a wired solver) can clear the interstitial and the
        // brain then proceeds to 'done'. We only give up (needs_manual) when the budget runs out.
        case 'captcha':
        case 'challenge':
        default:
          break // signin_email / reauth / totp / chooser / captcha / challenge / loading → keep acting
      }
      await sleep(1500)
    }
    return done('needs_manual', 'Quá thời gian — kiểm tra tay')
  } catch (e) {
    dbg(`[gmail-login ${task.email}] THREW: ${String(e)}`)
    return done('error', (e as Error).message)
  }
}
