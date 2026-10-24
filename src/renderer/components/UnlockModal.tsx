import { useState } from 'react'

interface Props {
  id: string
  name: string
  /** Mở khoá thành công → gọi để thực sự chạy profile. */
  onUnlocked: (id: string) => void
  onClose: () => void
  /** Có profile/tất cả bị xoá → cho App làm mới danh sách. */
  onWiped: () => void
}

/** Hộp thoại nhập mật khẩu khi mở một profile đã đặt khoá bảo vệ. */
export function UnlockModal({ id, name, onUnlocked, onClose, onWiped }: Props): JSX.Element {
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy || !pw) return
    setBusy(true)
    setMsg('')
    try {
      const res = await window.vgc.guardUnlock(id, pw)
      if (res.ok) {
        onClose()
        onUnlocked(id)
        return
      }
      if (res.action === 'wiped-profile') {
        window.alert(`Đã nhập sai quá số lần cho phép.\n\nProfile "${name}" đã bị XOÁ VĨNH VIỄN (cả dữ liệu cloud), không khôi phục được.`)
        onWiped()
        onClose()
        return
      }
      if (res.action === 'wiped-all') {
        window.alert('Đã nhập sai quá số lần cho phép.\n\nTẤT CẢ profile đã bị XOÁ VĨNH VIỄN (cả dữ liệu cloud), không khôi phục được.')
        onWiped()
        onClose()
        return
      }
      // 'wrong' và 'sos' đều hiện CÙNG một thông báo chung — không để lộ mật khẩu SOS.
      let text = 'Sai mật khẩu.'
      if (res.action === 'wrong') {
        const parts: string[] = []
        if (typeof res.remainingProfile === 'number') parts.push(`còn ${res.remainingProfile} lần trước khi xoá profile này`)
        if (typeof res.remainingGlobal === 'number') parts.push(`còn ${res.remainingGlobal} lần trước khi xoá TẤT CẢ`)
        if (parts.length) text += ' ' + parts.join(', ') + '.'
      }
      setMsg(text)
      setPw('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>🔒 Mở khoá profile</h3>
        <p className="hint" style={{ marginTop: -4 }}>
          Profile <b>{name}</b> đang được bảo vệ. Nhập mật khẩu để mở.
        </p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="Mật khẩu"
          autoComplete="off"
          style={{ width: '100%' }}
        />
        {msg && <p className="hint" style={{ color: '#e0534f', marginBottom: 0 }}>{msg}</p>}
        <div className="row-inline" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Huỷ</button>
          <button type="button" className="primary" disabled={busy || !pw} onClick={() => void submit()}>
            Mở khoá
          </button>
        </div>
      </div>
    </div>
  )
}
