import { useEffect, useState } from 'react'
import logo from '../assets/logo.png'
import { Icon } from './Icon'
import type { LicenseCheckResult, LicenseStatus } from '../../shared/types'

interface Props {
  license: LicenseCheckResult | null
  /** Re-run the check; resolves with the fresh verdict (null if the session changed). */
  onRecheck: () => Promise<LicenseStatus | null>
  onSignOut: () => Promise<void>
}

type Kind = 'denied' | 'expired' | 'unverified'

/** Vietnamese date for the "expires" value check.php returns (YYYY-MM-DD). */
function viDate(iso: string | null): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

/** Only two reasons are a real "no" from the admin list; everything else means the
 *  verdict could not be obtained (our network, or the VGC server). */
function kindOf(reason: string | undefined): Kind {
  if (reason === 'expired') return 'expired'
  if (reason === 'not-approved') return 'denied'
  return 'unverified'
}

const TITLE: Record<Kind, string> = {
  denied: 'Tài khoản chưa được cấp quyền',
  expired: 'Quyền truy cập đã hết hạn',
  unverified: 'Chưa xác minh được quyền truy cập'
}

function bodyOf(kind: Kind, license: LicenseStatus | null): string {
  if (kind === 'expired') {
    const when = license?.expires ? ` ngày ${viDate(license.expires)}` : ''
    return `Quyền dùng VGC Browser của email này đã hết hạn${when}. Liên hệ quản trị viên để gia hạn.`
  }
  if (kind === 'unverified') {
    return 'Không kiểm tra được quyền truy cập với máy chủ VGC (mạng của bạn hoặc máy chủ đang lỗi). Thử lại sau, hoặc báo quản trị viên nếu mạng vẫn bình thường.'
  }
  return 'VGC Browser chỉ dành cho nội bộ VGC Group. Quản trị viên cần thêm email này vào danh sách nội bộ trước khi bạn có thể sử dụng.'
}

const RECHECK_NOTE: Record<Kind, string> = {
  denied: 'Vẫn chưa được cấp quyền. Hãy báo quản trị viên duyệt email này rồi bấm lại.',
  expired: 'Vẫn đang hết hạn. Nhờ quản trị viên gia hạn rồi bấm lại.',
  unverified: 'Vẫn chưa kiểm tra được với máy chủ VGC. Kiểm tra mạng rồi thử lại.'
}

/**
 * Shown after a successful sign-in when the email is NOT on the internal list
 * (vgcbrowser.com/quanly), or when a signed-in user was revoked while working. The
 * session stays alive so "Kiểm tra lại" can pass the moment the admin approves the
 * email; "Đăng xuất" returns to the sign-in screen. While main is still closing the
 * profiles that were open at the moment of a revoke, a progress line asks the user not
 * to quit (their sessions are being saved to the cloud).
 */
export function AccessDenied({ license, onRecheck, onSignOut }: Props): JSX.Element {
  const [busy, setBusy] = useState<'check' | 'out' | null>(null)
  const [note, setNote] = useState('')
  const [closing, setClosing] = useState(license?.closing ?? 0)
  const kind = kindOf(license?.reason)

  // Follow the engines main is shutting down after a revoke until none is left.
  useEffect(() => {
    if (!closing) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const states = await window.vgc.runtimeStates()
        const live = states.filter((s) => s.status === 'running' || s.status === 'starting').length
        if (!cancelled) setClosing(live)
      } catch {
        if (!cancelled) setClosing(0)
      }
    }
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [closing])

  const recheck = async (): Promise<void> => {
    setBusy('check')
    setNote('')
    try {
      const fresh = await onRecheck()
      if (fresh && !fresh.approved) setNote(RECHECK_NOTE[kindOf(fresh.reason)])
    } catch {
      setNote('Không kiểm tra được. Thử lại sau ít phút.')
    } finally {
      setBusy(null)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy('out')
    try {
      await onSignOut()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-bg" aria-hidden="true">
        <div className="orb o1" />
        <div className="orb o2" />
        <div className="orb o3" />
        <div className="grid" />
      </div>
      <div className="auth-card auth-denied">
        <div className="auth-brand">
          <img className="auth-logo" src={logo} alt="VGC" />
          <div className="name">VGC Browser</div>
          <div className="sub">Nội bộ VGC Group</div>
        </div>

        <div className={`denied-badge ${kind === 'expired' ? 'expired' : kind === 'unverified' ? 'offline' : ''}`}>
          <Icon name={kind === 'unverified' ? 'wifi' : 'lock'} size={22} strokeWidth={2.2} />
        </div>
        <h2 className="denied-title">{TITLE[kind]}</h2>
        {license?.email && (
          <div className="denied-email">
            <Icon name="mail" size={13} />
            <span>{license.email}</span>
          </div>
        )}
        <p className="denied-body">{bodyOf(kind, license)}</p>

        {closing > 0 && (
          <p className="denied-closing">
            <Icon name="refresh" size={14} className="spin" />
            Đang đóng {closing} profile đang mở và lưu phiên lên cloud… đừng tắt app.
          </p>
        )}

        <button
          className="auth-btn"
          onClick={() => void recheck()}
          disabled={busy !== null || closing > 0}
        >
          <Icon name="refresh" size={15} className={busy === 'check' ? 'spin' : ''} />
          {busy === 'check' ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
        </button>
        {note && <p className="auth-msg err">{note}</p>}

        <p className="auth-links">
          <a onClick={() => (busy || closing > 0 ? undefined : void signOut())}>
            {busy === 'out' ? 'Đang đăng xuất…' : 'Đăng xuất, dùng tài khoản khác'}
          </a>
        </p>

        <p className="auth-foot">Chỉ dùng nội bộ · Quản trị viên duyệt email tại trang quản lý VGC</p>
      </div>
    </div>
  )
}
