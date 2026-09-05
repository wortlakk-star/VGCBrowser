import { useState, type KeyboardEvent } from 'react'
import { getCloud } from '../cloud'
import logo from '../assets/logo.png'
import { Icon } from './Icon'

/** Map common Supabase auth errors to Vietnamese. */
function viErr(m: string): string {
  const s = m.toLowerCase()
  if (s.includes('invalid login')) return 'Sai email hoặc mật khẩu.'
  if (s.includes('email not confirmed')) return 'Email chưa xác nhận — kiểm tra hộp thư rồi bấm link xác nhận.'
  if (s.includes('already registered') || s.includes('already been registered'))
    return 'Email này đã có tài khoản. Hãy đăng nhập.'
  if (s.includes('password')) return 'Mật khẩu không hợp lệ (tối thiểu 6 ký tự).'
  if (s.includes('rate limit')) return 'Thử lại sau ít phút (quá nhiều yêu cầu).'
  if (s.includes('failed to fetch')) return 'Không kết nối được máy chủ. Kiểm tra mạng.'
  if (s.includes('signups not allowed') || s.includes('signup is disabled'))
    return 'Đăng ký đang tắt. Liên hệ quản trị viên để được cấp tài khoản.'
  return m
}

interface Props {
  onAuthed: () => Promise<void>
}

export function AuthScreen({ onAuthed }: Props): JSX.Element {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [ok, setOk] = useState(false)

  const switchMode = (m: 'login' | 'signup'): void => {
    setMode(m)
    setMsg('')
  }

  const submit = async (): Promise<void> => {
    const c = await getCloud()
    if (!c) {
      setOk(false)
      setMsg('Hệ thống tài khoản chưa sẵn sàng. Thử lại sau.')
      return
    }
    if (!email.trim() || !pass) {
      setOk(false)
      setMsg('Nhập email và mật khẩu.')
      return
    }
    setBusy(true)
    setMsg('')
    try {
      if (mode === 'login') {
        const { error } = await c.auth.signInWithPassword({ email: email.trim(), password: pass })
        if (error) {
          setOk(false)
          setMsg(viErr(error.message))
        } else {
          // Gate.tsx now checks the email against the internal list before showing the app.
          await onAuthed()
        }
      } else {
        if (pass.length < 6) {
          setOk(false)
          setMsg('Mật khẩu tối thiểu 6 ký tự.')
          return
        }
        if (pass !== pass2) {
          setOk(false)
          setMsg('Mật khẩu nhập lại không khớp.')
          return
        }
        // Internal only: the admin must have put this email on the list BEFORE an account
        // can be created for it. (The list is re-checked at sign-in and while the app runs.)
        const pre = await window.vgc.licensePrecheck(email.trim())
        if (!pre.approved) {
          setOk(false)
          // One wording for every "no" from the list (not on it / expired) so the sign-up
          // tab cannot be used to probe which internal addresses exist.
          setMsg(
            pre.reason === 'invalid-email'
              ? 'Địa chỉ email không hợp lệ.'
              : pre.reason === 'rate-limited'
                ? 'Bạn thử quá nhiều lần. Đợi một phút rồi thử lại.'
                : pre.reason === 'unverified'
                  ? 'Không kiểm tra được danh sách nội bộ (mạng của bạn hoặc máy chủ VGC đang lỗi). Thử lại sau ít phút.'
                  : 'Email này chưa được quản trị viên cấp quyền dùng VGC. Nhờ quản trị viên thêm hoặc gia hạn email trước, rồi tạo tài khoản.'
          )
          return
        }
        const { data, error } = await c.auth.signUp({
          email: email.trim(),
          password: pass,
          options: { data: { name: name.trim() }, emailRedirectTo: 'https://vgcbrowser.com' }
        })
        if (error) {
          setOk(false)
          setMsg(viErr(error.message))
        } else if (data.session) {
          await onAuthed()
        } else {
          setOk(true)
          setMsg('Tạo tài khoản thành công! Kiểm tra email để xác nhận, rồi đăng nhập.')
          setMode('login')
          setPass('')
          setPass2('')
        }
      }
    } catch (error) {
      setOk(false)
      setMsg(viErr(error instanceof Error ? error.message : 'Không xác minh được phiên đăng nhập.'))
    } finally {
      setBusy(false)
    }
  }

  const forgot = async (): Promise<void> => {
    if (!email.trim()) {
      setOk(false)
      setMsg('Nhập email vào ô trên rồi bấm "Quên mật khẩu" để nhận link đặt lại.')
      return
    }
    const c = await getCloud()
    if (!c) return
    setBusy(true)
    const { error } = await c.auth.resetPasswordForEmail(email.trim())
    setBusy(false)
    setOk(!error)
    setMsg(error ? viErr(error.message) : 'Đã gửi email đặt lại mật khẩu tới ' + email.trim())
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !busy) void submit()
  }

  return (
    <div className="auth-screen">
      <div className="auth-bg" aria-hidden="true">
        <div className="orb o1" />
        <div className="orb o2" />
        <div className="orb o3" />
        <div className="grid" />
      </div>
      <div className="auth-card">
        <div className="auth-brand">
          <img className="auth-logo" src={logo} alt="VGC" />
          <div className="name">VGC Browser</div>
          <div className="sub">Antidetect Browser · Nội bộ VGC Group</div>
        </div>

        <div className="auth-tabs">
          <button
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            Đăng nhập
          </button>
          <button
            className={`auth-tab ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => switchMode('signup')}
          >
            Tạo tài khoản
          </button>
        </div>

        {mode === 'signup' && (
          <p className="auth-note">
            <Icon name="shield" size={13} />
            Chỉ email đã được quản trị viên thêm vào danh sách nội bộ mới tạo được tài khoản.
          </p>
        )}

        {mode === 'signup' && (
          <div className="auth-input">
            <Icon name="user" size={17} />
            <input
              className="auth-field"
              placeholder="Tên hiển thị (tuỳ chọn)"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 160))}
              onKeyDown={onKey}
            />
          </div>
        )}
        <div className="auth-input">
          <Icon name="mail" size={17} />
          <input
            className="auth-field"
            type="email"
            placeholder="Email nội bộ"
            value={email}
            onChange={(e) => setEmail(e.target.value.slice(0, 320))}
            onKeyDown={onKey}
            autoFocus
          />
        </div>
        <div className="auth-input">
          <Icon name="lock" size={17} />
          <input
            className="auth-field"
            type="password"
            placeholder="Mật khẩu"
            value={pass}
            onChange={(e) => setPass(e.target.value.slice(0, 1024))}
            onKeyDown={onKey}
          />
        </div>
        {mode === 'signup' && (
          <div className="auth-input">
            <Icon name="lock" size={17} />
            <input
              className="auth-field"
              type="password"
              placeholder="Nhập lại mật khẩu"
              value={pass2}
              onChange={(e) => setPass2(e.target.value.slice(0, 1024))}
              onKeyDown={onKey}
            />
          </div>
        )}

        <button className="auth-btn" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
        </button>

        {msg && <p className={`auth-msg ${ok ? 'ok' : 'err'}`}>{msg}</p>}

        <p className="auth-links">
          {mode === 'login' ? (
            <>
              <a onClick={() => void forgot()}>Quên mật khẩu?</a>
              <span className="sep">·</span>
              <a onClick={() => switchMode('signup')}>Chưa có tài khoản</a>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--dim)' }}>Đã có tài khoản? </span>
              <a onClick={() => switchMode('login')}>Đăng nhập</a>
            </>
          )}
        </p>

        <div className="auth-badges">
          <span>
            <Icon name="fingerprint" size={13} />
            Vân tay native
          </span>
          <span>
            <Icon name="cloud" size={13} />
            Đồng bộ đa máy
          </span>
          <span>
            <Icon name="shield" size={13} />
            Mã hoá đầu-cuối
          </span>
        </div>

        <p className="auth-foot">VGC Browser · Chỉ dùng nội bộ VGC Group</p>
      </div>
    </div>
  )
}
