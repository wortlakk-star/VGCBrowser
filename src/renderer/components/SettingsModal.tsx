import { useEffect, useState, type CSSProperties } from 'react'
import type { UpdateStatus } from '../../shared/types'

const inp: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  color: 'var(--text)',
  outline: 'none'
}

interface Props {
  onClose: () => void
  theme: 'dark' | 'light'
  onSetTheme: (t: 'dark' | 'light') => void
  accountEmail?: string
  onSignOut: () => void
  onOpenCloud: () => void
}

function updateLabel(s: UpdateStatus | null): string {
  if (!s) return ''
  switch (s.phase) {
    case 'checking':
      return '⏳ Đang kiểm tra cập nhật…'
    case 'available':
      return s.manualDownloadUrl
        ? `⬇ Có bản mới ${s.newVersion ? `v${s.newVersion}` : ''} — bấm "Tải về" để cập nhật.`
        : `⬇ Có bản mới ${s.newVersion ? `v${s.newVersion}` : ''} — đang tải…`
    case 'downloading':
      return `⬇ Đang tải bản mới… ${s.percent ?? 0}%`
    case 'downloaded':
      return `✅ Đã tải xong ${s.newVersion ? `v${s.newVersion}` : 'bản mới'} — bấm "Khởi động lại để cập nhật".`
    case 'up-to-date':
      return '✓ Bạn đang dùng phiên bản mới nhất.'
    case 'error':
      return `⚠ Lỗi kiểm tra cập nhật: ${s.message ?? ''}`
    case 'dev':
      return `ℹ ${s.message ?? 'Chỉ chạy ở bản đã cài đặt.'}`
    default:
      return ''
  }
}

export function SettingsModal({
  onClose,
  theme,
  onSetTheme,
  accountEmail,
  onSignOut,
  onOpenCloud
}: Props): JSX.Element {
  const [version, setVersion] = useState<string>('')
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  // iProyal proxy provider credentials (used by Proxy → "Tạo proxy qua API").
  const [ipToken, setIpToken] = useState('')
  const [ipUser, setIpUser] = useState('')
  const [ipPass, setIpPass] = useState('')
  const [ipMsg, setIpMsg] = useState('')
  // Evomi proxy provider — a single API key is enough.
  const [evoKey, setEvoKey] = useState('')
  const [evoMsg, setEvoMsg] = useState('')

  const saveIproyal = async (): Promise<void> => {
    await window.vgc.saveProviderCreds({
      iproyal: { username: ipUser.trim(), password: ipPass.trim(), apiToken: ipToken.trim() }
    })
    setIpMsg('✓ Đã lưu tài khoản iProyal.')
  }

  const saveEvomi = async (): Promise<void> => {
    await window.vgc.saveProviderCreds({ evomi: { apiKey: evoKey.trim() } })
    setEvoMsg('✓ Đã lưu API key Evomi.')
  }

  useEffect(() => {
    void window.vgc.getProviderCreds().then((c) => {
      if (c.iproyal) {
        setIpUser(c.iproyal.username || '')
        setIpPass(c.iproyal.password || '')
        setIpToken(c.iproyal.apiToken || '')
      }
      if (c.evomi) setEvoKey(c.evomi.apiKey || '')
    })
    void window.vgc.getVersion().then(setVersion)
    // The engine always runs in Native (VGC Core) mode — the antidetect-correct
    // config that also keeps Google login working — so the manual toggles were
    // removed. Normalise any stale saved value so no profile is stuck in CDP /
    // system-Chrome mode.
    void window.vgc.getSettings().then((s) => {
      if (s.nativeMode === false || s.useSystemBrowser) {
        void window.vgc.saveSettings({ nativeMode: true, useSystemBrowser: false })
      }
    })
    void window.vgc.getUpdateStatus().then((s) => {
      if (s.phase !== 'idle') setUpdate(s)
    })
    return window.vgc.onUpdateStatus(setUpdate)
  }, [])

  const checking = update?.phase === 'checking' || update?.phase === 'downloading'
  const downloaded = update?.phase === 'downloaded'
  // macOS: an unsigned build can't auto-install, so offer a manual download instead.
  const manual = update?.phase === 'available' && !!update?.manualDownloadUrl

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

          <section className="card">
            <h3>🌐 Nhà cung cấp Proxy — iProyal</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Nhập 1 lần ở đây, sau đó vào <b>Proxy</b> chỉ cần bấm <b>Tạo proxy</b>. Lấy{' '}
              <b>API token</b> tại{' '}
              <a
                href="https://dashboard.iproyal.com/me/settings"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Settings → API
              </a>
              ; <b>Username/Password</b> ở mục Residential → “Change proxies credentials”.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              <input
                placeholder="API token"
                value={ipToken}
                onChange={(e) => setIpToken(e.target.value)}
                style={inp}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  placeholder="Username"
                  value={ipUser}
                  onChange={(e) => setIpUser(e.target.value)}
                  style={inp}
                />
                <input
                  placeholder="Password"
                  type="password"
                  value={ipPass}
                  onChange={(e) => setIpPass(e.target.value)}
                  style={inp}
                />
              </div>
              <div className="proxy-check" style={{ alignItems: 'center', gap: 10 }}>
                <button className="btn primary" onClick={() => void saveIproyal()}>
                  💾 Lưu tài khoản iProyal
                </button>
                {ipMsg && (
                  <span style={{ color: 'var(--green)', fontSize: 12 }}>{ipMsg}</span>
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Phiên bản &amp; Cập nhật</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              VGC Browser {version ? `v${version}` : '…'}
            </p>
            <div className="proxy-check">
              {downloaded ? (
                <button className="btn primary" onClick={() => void window.vgc.installUpdate()}>
                  ⟳ Khởi động lại để cập nhật
                </button>
              ) : manual ? (
                <button className="btn primary" onClick={() => void window.vgc.openUpdateDownload()}>
                  ⬇ Tải về để cập nhật
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={checking}
                  onClick={() => void window.vgc.checkForUpdate()}
                >
                  {checking ? 'Đang xử lý…' : '⬇ Kiểm tra cập nhật'}
                </button>
              )}
            </div>
            {update && update.phase !== 'idle' && (
              <p className="hint" style={{ marginBottom: 0 }}>
                {updateLabel(update)}
              </p>
            )}
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
