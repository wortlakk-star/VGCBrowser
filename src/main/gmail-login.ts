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

const HOME_URL = 'https://myaccount.google.com/'
const LOGIN_BUDGET_MS = 120000 // 2 min per account

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const PHASE_MSG: Record<string, string> = {
  launch: 'Đang mở profile…',
  signin_email: 'Đang nhập email…',
  reauth: 'Đang nhập mật khẩu…',
  totp: 'Đang nhập mã 2FA…',
  challenge: 'Gặp thử thách xác minh…',
  captcha: 'Gặp captcha…',
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
    while (Date.now() < deadline) {
      // Rebuild each poll so the injected TOTP is the CURRENT code. newPassword is '' —
      // the change-password branch of the brain never fires (we're on the account home, which
      // has no two-password form), so login never mutates anything.
      const cfg = JSON.stringify({
        email: task.email,
        oldPassword: task.password,
        newPassword: '',
        totp: secret ? generateTotp(secret) : '',
        loginOnly: true // the brain must NEVER type/submit a password in login mode
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

      switch (res.state) {
        case 'done':
          return done('live', 'Đăng nhập thành công')
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
        case 'captcha':
        case 'challenge':
          return done('needs_manual', 'Cần xác minh tay' + (res.detail ? ` (${res.detail})` : ''))
        default:
          break // signin_email / reauth / totp / loading / unknown → let the brain keep acting
      }
      await sleep(1500)
    }
    return done('needs_manual', 'Quá thời gian — kiểm tra tay')
  } catch (e) {
    dbg(`[gmail-login ${task.email}] THREW: ${String(e)}`)
    return done('error', (e as Error).message)
  }
}
