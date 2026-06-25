import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../shared/types'

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
  const [useSystemBrowser, setUseSystemBrowser] = useState(false)
  // Default ON (matches the engine default) until settings load.
  const [nativeMode, setNativeMode] = useState(true)

  useEffect(() => {
    void window.vgc.getVersion().then(setVersion)
    void window.vgc.getSettings().then((s) => {
      setUseSystemBrowser(!!s.useSystemBrowser)
      setNativeMode(s.nativeMode !== false)
    })
    void window.vgc.getUpdateStatus().then((s) => {
      if (s.phase !== 'idle') setUpdate(s)
    })
    return window.vgc.onUpdateStatus(setUpdate)
  }, [])

  const toggleSystemBrowser = (next: boolean): void => {
    setUseSystemBrowser(next)
    void window.vgc.saveSettings({ useSystemBrowser: next })
  }
  const toggleNativeMode = (next: boolean): void => {
    setNativeMode(next)
    void window.vgc.saveSettings({ nativeMode: next })
  }

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
            <h3>Engine trình duyệt</h3>
            <label
              className="hint"
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                cursor: 'pointer',
                marginTop: 0,
                marginBottom: 10
              }}
            >
              <input
                type="checkbox"
                checked={nativeMode}
                onChange={(e) => toggleNativeMode(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                <b>Chế độ gốc (giống GoLogin) — BẬT để đăng nhập Google được.</b> Engine tự
                giả fingerprint, KHÔNG gắn trình gỡ lỗi CDP (thứ Google chặn). Bật = vào
                Google bình thường + vẫn chống phát hiện. Tắt = bật lại tiêm CDP (thêm
                múi giờ/JS + đồng bộ tab + API automation) nhưng Google sẽ chặn đăng nhập.
                <i> Đóng &amp; mở lại profile sau khi đổi.</i>
              </span>
            </label>
            <label
              className="hint"
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                cursor: 'pointer',
                marginTop: 0
              }}
            >
              <input
                type="checkbox"
                checked={useSystemBrowser}
                onChange={(e) => toggleSystemBrowser(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                Dùng Google Chrome hệ thống làm engine — bật cái này nếu Google báo
                <b> &quot;browser may not be secure&quot;</b> khi đăng nhập. Chrome thật được
                Google tin tưởng; fingerprint vẫn được áp dụng. (Đóng &amp; mở lại profile
                sau khi đổi. Cần đã cài Google Chrome trên máy.)
              </span>
            </label>
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
