import { useState } from 'react'
import type { OsType } from '../../shared/types'

interface Props {
  groups: string[]
  defaultGroup?: string
  defaultName: string
  onClose: () => void
  onCreated: () => void
}

const OS_OPTIONS: Array<{ v: OsType; label: string; icon: string }> = [
  { v: 'windows', label: 'Windows', icon: '🪟' },
  { v: 'macos', label: 'macOS', icon: '' },
  { v: 'linux', label: 'Linux', icon: '🐧' },
  { v: 'android', label: 'Android', icon: '🤖' }
]

// Default a new profile to THIS machine's OS — a profile whose OS matches the host is the
// hardest to detect (its claimed GPU/Canvas matches what the engine actually renders).
const HOST_OS: OsType = /Mac/i.test(navigator.userAgent)
  ? 'macos'
  : /Win/i.test(navigator.userAgent)
    ? 'windows'
    : /Android/i.test(navigator.userAgent)
      ? 'android'
      : 'linux'

export function CreateProfileModal({
  groups,
  defaultGroup,
  defaultName,
  onClose,
  onCreated
}: Props): JSX.Element {
  const [name, setName] = useState(defaultName)
  const [os, setOs] = useState<OsType>(HOST_OS)
  const [group, setGroup] = useState(defaultGroup ?? '')
  const [count, setCount] = useState(1)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const n = Math.max(1, Math.min(100, count || 1))
      const startUrls = url.trim() ? [url.trim()] : []
      for (let i = 0; i < n; i++) {
        const nm = n > 1 ? `${name.trim() || 'Profile'} ${i + 1}` : name.trim() || 'Profile mới'
        await window.vgc.createProfile({
          name: nm,
          os,
          group: group || undefined,
          startUrls
        })
      }
      onCreated()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <header className="modal-head">
          <h2>Tạo profile mới</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <label>
              Tên profile
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>

            <label>Hệ điều hành</label>
            <div className="seg" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {OS_OPTIONS.map((o) => (
                <button
                  key={o.v}
                  className={`seg-btn ${os === o.v ? 'active' : ''}`}
                  onClick={() => setOs(o.v)}
                >
                  {o.icon} {o.label}
                </button>
              ))}
            </div>

            <label style={{ marginTop: 14 }}>
              Nhóm
              <select
                className="group-select"
                style={{ width: '100%', marginTop: 4 }}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                <option value="">Không nhóm (Tất cả)</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>

            <label>
              URL mở đầu (tuỳ chọn)
              <input
                placeholder="https://… (để trống nếu không cần)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>

            <label>
              Số lượng tạo
              <input
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(e) => setCount(Number(e.target.value) || 1)}
              />
            </label>
            <p className="hint">
              Tạo nhiều profile cùng lúc — mỗi profile có vân tay riêng (khớp hệ điều hành đã chọn).
            </p>
          </section>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={busy}>
            {busy ? 'Đang tạo…' : count > 1 ? `Tạo ${count} profile` : 'Tạo profile'}
          </button>
        </footer>
      </div>
    </div>
  )
}
