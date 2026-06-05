import { useState, type CSSProperties, type KeyboardEvent } from 'react'
import { getCloud } from '../cloud'

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

const TEAL = 'linear-gradient(180deg, #1aa896 0%, #0e8f7e 100%)'
const YELLOW = '#F5CE47'

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '14px 16px',
  borderRadius: 8,
  border: '1px solid rgba(0,0,0,.08)',
  background: '#fff',
  color: '#1a1a1a',
  fontSize: 15,
  outline: 'none',
  marginBottom: 12
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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: TEAL,
        overflow: 'auto',
        padding: 24
      }}
    >
      <div style={{ width: 420, maxWidth: '92vw', color: '#fff' }}>
        <h1 style={{ textAlign: 'center', fontSize: 38, fontWeight: 800, margin: '0 0 28px' }}>
          {mode === 'login' ? 'Đăng nhập' : 'Đăng ký'}
        </h1>

        {mode === 'signup' && (
          <input
            style={inputStyle}
            placeholder="Tên hiển thị (tuỳ chọn)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey}
          />
        )}
        <input
          style={inputStyle}
          type="email"
          placeholder="Địa chỉ email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={onKey}
          autoFocus
        />
        <input
          style={inputStyle}
          type="password"
          placeholder="Mật khẩu"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={onKey}
        />
        {mode === 'signup' && (
          <input
            style={inputStyle}
            type="password"
            placeholder="Nhập lại mật khẩu"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            onKeyDown={onKey}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
          <button
            onClick={() => void submit()}
            disabled={busy}
            style={{
              background: YELLOW,
              color: '#1a1a1a',
              fontWeight: 700,
              fontSize: 15,
              border: 'none',
              borderRadius: 24,
              padding: '13px 48px',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1
            }}
          >
            {busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </div>

        {msg && (
          <p
            style={{
              textAlign: 'center',
              marginTop: 16,
              fontSize: 13.5,
              color: ok ? '#eafff5' : '#ffe2e2',
              fontWeight: 600
            }}
          >
            {msg}
          </p>
        )}

        <p style={{ textAlign: 'center', marginTop: 22, fontSize: 14, fontWeight: 600 }}>
          {mode === 'login' ? (
            <>
              <span style={{ opacity: 0.85 }}>Chưa có tài khoản? </span>
              <a
                style={{ color: '#fff', cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => {
                  setMode('signup')
                  setMsg('')
                }}
              >
                Đăng ký
              </a>
              <span style={{ opacity: 0.6 }}> · </span>
              <a
                style={{ color: '#fff', cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => void forgot()}
              >
                Quên mật khẩu?
              </a>
            </>
          ) : (
            <>
              <span style={{ opacity: 0.85 }}>Đã có tài khoản? </span>
              <a
                style={{ color: '#fff', cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => {
                  setMode('login')
                  setMsg('')
                }}
              >
                Đăng nhập
              </a>
            </>
          )}
        </p>

        <p style={{ textAlign: 'center', marginTop: 40, fontSize: 12, opacity: 0.7 }}>
          ◆ VGC Browser · Antidetect Browser
        </p>
      </div>
    </div>
  )
}
