import { useState, type KeyboardEvent } from 'react'
import { getCloud } from '../cloud'
import logo from '../assets/logo.png'

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
  return m
}

interface Props {
  onAuthed: () => void
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
          onAuthed() // guaranteed redirect into the app
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
        const { data, error } = await c.auth.signUp({
          email: email.trim(),
          password: pass,
          options: { data: { name: name.trim() }, emailRedirectTo: 'https://vgcbrowser.com' }
        })
        if (error) {
          setOk(false)
          setMsg(viErr(error.message))
        } else if (data.session) {
          onAuthed() // auto-signed-in
        } else {
          setOk(true)
          setMsg('Tạo tài khoản thành công! Kiểm tra email để xác nhận, rồi đăng nhập.')
          setMode('login')
          setPass('')
          setPass2('')
        }
      }
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
      <div className="auth-card">
        <div className="auth-brand">
          <img className="auth-logo" src={logo} alt="VGC" />
          <div className="name">VGC Browser</div>
          <div className="sub">Antidetect Browser · VGC Group</div>
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
            Đăng ký
          </button>
        </div>

        {mode === 'signup' && (
          <input
            className="auth-field"
            placeholder="Tên hiển thị (tuỳ chọn)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey}
          />
        )}
        <input
          className="auth-field"
          type="email"
          placeholder="Địa chỉ email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={onKey}
          autoFocus
        />
        <input
          className="auth-field"
          type="password"
          placeholder="Mật khẩu"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={onKey}
        />
        {mode === 'signup' && (
          <input
            className="auth-field"
            type="password"
            placeholder="Nhập lại mật khẩu"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            onKeyDown={onKey}
          />
        )}

        <button className="auth-btn" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
        </button>

        {msg && <p className={`auth-msg ${ok ? 'ok' : 'err'}`}>{msg}</p>}

        <p className="auth-links">
          {mode === 'login' ? (
            <a onClick={() => void forgot()}>Quên mật khẩu?</a>
          ) : (
            <>
              <span style={{ color: 'var(--dim)' }}>Đã có tài khoản? </span>
              <a onClick={() => switchMode('login')}>Đăng nhập</a>
            </>
          )}
        </p>

        <p className="auth-foot">
          <img
            src={logo}
            alt=""
            style={{ width: 14, height: 14, verticalAlign: 'middle', marginRight: 4 }}
          />
          VGC Browser · Antidetect Browser
        </p>
      </div>
    </div>
  )
}
