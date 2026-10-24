import { useState } from 'react'

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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title ?? '🔒 Mật khẩu bảo mật'}</h3>
        <p className="hint" style={{ marginTop: -4 }}>{desc ?? 'Nhập mật khẩu chủ để tiếp tục.'}</p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="Mật khẩu bảo mật"
          autoComplete="off"
          style={{ width: '100%' }}
        />
        {msg && <p className="hint" style={{ color: '#e0534f', marginBottom: 0 }}>{msg}</p>}
        <div className="row-inline" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Huỷ</button>
          <button type="button" className="primary" disabled={busy || !pw} onClick={() => void submit()}>Xác nhận</button>
        </div>
      </div>
    </div>
  )
}
