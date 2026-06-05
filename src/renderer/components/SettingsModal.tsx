interface Props {
  onClose: () => void
  theme: 'dark' | 'light'
  onSetTheme: (t: 'dark' | 'light') => void
  accountEmail?: string
  onSignOut: () => void
  onOpenCloud: () => void
}

export function SettingsModal({
  onClose,
  theme,
  onSetTheme,
  accountEmail,
  onSignOut,
  onOpenCloud
}: Props): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <header className="modal-head">
          <h2>⚙ Cài đặt</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <h3>Tài khoản</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              👤 {accountEmail || 'Đang đăng nhập…'}
            </p>
            <div className="proxy-check">
              <button className="btn" onClick={onOpenCloud}>
                ☁ Cloud &amp; Team
              </button>
              <button className="btn" onClick={onSignOut}>
                🔁 Đổi tài khoản
              </button>
              <button className="btn danger" onClick={onSignOut}>
                ⎋ Đăng xuất
              </button>
            </div>
          </section>

          <section className="card">
            <h3>Giao diện</h3>
            <div className="seg">
              <button
                className={`seg-btn ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => onSetTheme('dark')}
              >
                🌙 Tối
              </button>
              <button
                className={`seg-btn ${theme === 'light' ? 'active' : ''}`}
                onClick={() => onSetTheme('light')}
              >
                ☀ Sáng
              </button>
            </div>
          </section>
        </div>

        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>
            Đóng
          </button>
        </footer>
      </div>
    </div>
  )
}
