import { useEffect, useRef, useState } from 'react'
import logo from '../assets/logo.png'

interface Props {
  /** Mở khoá thành công (mật khẩu chủ — hoặc SOS: đã xoá xong, vào app trống). */
  onUnlocked: () => void
}

/** Màn hình nhập mật khẩu khi vào VGC (bật ở Cài đặt → Khoá bảo vệ → "Yêu cầu mật khẩu khi mở VGC"). */
export function LockScreen({ onUnlocked }: Props): JSX.Element {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    if (waitUntil <= Date.now()) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [waitUntil])

  const waiting = Math.max(0, Math.ceil((waitUntil - now) / 1000))

  const submit = async (): Promise<void> => {
    if (busy || !pw || waiting > 0) return
    setBusy(true)
    setMsg('')
    try {
      const r = await window.vgc.guardAppUnlock(pw)
      if (r.ok) {
        setPw('')
        onUnlocked()
        return
      }
      setPw('')
      if (r.retryAfterMs && r.retryAfterMs > 0) {
        setWaitUntil(Date.now() + r.retryAfterMs)
        setNow(Date.now())
        setMsg('Sai mật khẩu.')
      } else {
        setMsg('Sai mật khẩu.')
      }
      inputRef.current?.focus()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        color: 'var(--fg, #eef0f7)',
        padding: 20
      }}
    >
      <div
        style={{
          maxWidth: 400,
          width: '96%',
          textAlign: 'center',
          background: 'linear-gradient(180deg,#0e1120,#0a0c16)',
          border: '1px solid #2a3146',
          borderRadius: 18,
          padding: 34,
          boxShadow: '0 30px 80px rgba(0,0,0,.6)'
        }}
      >
        <img src={logo} alt="VGC" style={{ width: 60, height: 60 }} />
        <h2 style={{ margin: '16px 0 6px', fontSize: 21 }}>VGC đang khoá</h2>
        <p style={{ margin: '0 0 18px', color: 'var(--dim,#9aa3bd)', fontSize: 14, lineHeight: 1.6 }}>
          Nhập mật khẩu bảo mật để mở.
        </p>
        <input
          ref={inputRef}
          type="password"
          value={pw}
          autoComplete="off"
          placeholder="Mật khẩu"
          disabled={busy || waiting > 0}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            font: 'inherit',
            fontSize: 16,
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid #2a3146',
            background: '#141826',
            color: 'inherit',
            textAlign: 'center',
            letterSpacing: 2
          }}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !pw || waiting > 0}
          style={{
            marginTop: 14,
            width: '100%',
            background: '#18c0ad',
            border: 'none',
            color: '#05201c',
            fontWeight: 700,
            borderRadius: 10,
            padding: '12px 22px',
            fontSize: 15,
            cursor: busy || !pw || waiting > 0 ? 'default' : 'pointer',
            opacity: busy || !pw || waiting > 0 ? 0.6 : 1
          }}
        >
          {busy ? 'Đang kiểm tra…' : waiting > 0 ? `Chờ ${waiting} giây` : 'Mở khoá'}
        </button>
        {msg && <p style={{ margin: '12px 0 0', color: '#ff7a76', fontSize: 13 }}>{msg}</p>}
      </div>
    </div>
  )
}
