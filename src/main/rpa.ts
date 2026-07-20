// ── VGC Browser — RPA "warm-up" (keep farmed Gmail accounts trusted) ─────────
// Opens a profile in automation mode (CDP pipe — the ONLY way to drive a native-mode
// profile), confirms it's still signed in, then performs human-like Gmail activity for a
// few minutes (scroll, open + read a random email, pause, scroll back) with randomized
// timing, and closes — the session is saved to the profile so nothing is lost. Never
// changes anything on the account; it only browses.
import type { GmailProgress, RpaResult } from '../shared/types'
import { launchProfile, stopProfile, getAutomationConn } from './profile-manager'
import { attachPage } from './gmail-password'
import { dbg } from './dbg'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const rnd = (min: number, max: number): number => min + Math.random() * (max - min)

export interface WarmupOpts {
  minutes?: number
}

export async function runWarmup(
  profileId: string,
  name: string,
  opts: WarmupOpts,
  onProgress: (p: GmailProgress) => void
): Promise<RpaResult> {
  const emit = (phase: string, message: string): void => {
    try {
      onProgress({ profileId, email: name, phase, message })
    } catch {
      /* a throwing progress callback must never break the run */
    }
  }
  const finish = (status: RpaResult['status'], message: string): RpaResult => {
    try {
      stopProfile(profileId) // persists the session to disk
    } catch {
      /* ignore */
    }
    return { profileId, name, status, message }
  }

  emit('launch', 'Đang mở profile…')
  try {
    await launchProfile(profileId, { automation: true })
    const conn = getAutomationConn(profileId)
    if (!conn) throw new Error('Không mở được kênh điều khiển (CDP)')
    const page = await attachPage(conn)
    await sleep(rnd(800, 1500))
    await page.navigate('https://mail.google.com/mail/u/0/#inbox')
    await sleep(rnd(3500, 6000))

    // Still signed in? A login form / accounts.google.com URL means the session expired.
    const url = String((await page.evaluate('location.href').catch(() => '')) || '')
    const hasLogin =
      (await page
        .evaluate('!!document.querySelector("input[type=email], input[type=password]")')
        .catch(() => false)) === true
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(url) || hasLogin) {
      return finish('not_logged_in', 'Chưa đăng nhập — hãy "Đăng nhập Gmail" trước')
    }

    emit('warm', 'Đang nuôi (hoạt động như người thật)…')
    const deadline = Date.now() + Math.max(0.5, opts.minutes ?? 2) * 60000
    while (Date.now() < deadline) {
      await page.evaluate(`window.scrollBy(0, ${Math.round(rnd(200, 700))})`).catch(() => {})
      await sleep(rnd(1500, 4000))
      // ~40% of ticks: open + read a random email, then return to the inbox.
      if (Math.random() < 0.4) {
        await page
          .evaluate(
            '(function(){var r=document.querySelectorAll("tr.zA");if(r.length){r[Math.floor(Math.random()*Math.min(r.length,12))].click();}})()'
          )
          .catch(() => {})
        emit('warm', 'Đang đọc mail…')
        await sleep(rnd(4000, 9000))
        await page
          .evaluate(
            'history.length>1?history.back():location.assign("https://mail.google.com/mail/u/0/#inbox")'
          )
          .catch(() => {})
        await sleep(rnd(2500, 4500))
      }
      // ~30% of ticks: scroll back to the top.
      if (Math.random() < 0.3) {
        await page.evaluate('window.scrollTo(0,0)').catch(() => {})
        await sleep(rnd(1200, 2500))
      }
    }
    return finish('done', 'Đã nuôi xong')
  } catch (e) {
    dbg(`[rpa ${name}] ${String(e)}`)
    return finish('error', (e as Error).message)
  }
}
