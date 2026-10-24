import { useState } from 'react'
import { Icon } from './Icon'

interface Props {
  title?: string
  desc?: string
  /** Gọi sau khi nhập đúng mật khẩu bảo mật (đã bật phiên admin ở main). */
  onOk: () => void
  onClose: () => void
}

/** Hộp nhập nhanh "mật khẩu bảo mật" (mật khẩu chủ) để thực hiện một thao tác khoá. */
export function AdminPromptModal({ title, desc, onOk, onClose }: Props): JSX.Element {
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy || !pw) return
    setBusy(true)
    setMsg('')
    try {
      const ok = await window.vgc.guardCheckAdmin(pw)
      if (ok) {
        onClose()
        onOk()
      } else {
        setMsg('Sai mật khẩu bảo mật.')
        setPw('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop flat" onClick={onClose}>
      <div className="modal" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="shield" size={18} style={{ color: 'var(--accent-2)' }} />
            {title ?? 'Mật khẩu bảo mật'}
          </h2>
          <button className="btn" onClick={onClose}>
            <Icon name="x" size={16} strokeWidth={2.4} />
          </button>
        </header>
        <div className="modal-body">
          <p className="hint" style={{ margin: 0 }}>{desc ?? 'Nhập mật khẩu chủ để tiếp tục.'}</p>
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
            placeholder="Mật khẩu bảo mật"
            autoComplete="off"
          />
          {msg && <p className="hint" style={{ margin: 0, color: '#e0534f', fontWeight: 600 }}>{msg}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>Huỷ</button>
          <button className="btn primary" disabled={busy || !pw} onClick={() => void submit()}>
            {busy ? 'Đang kiểm tra…' : 'Xác nhận'}
          </button>
        </footer>
      </div>
    </div>
  )
}
