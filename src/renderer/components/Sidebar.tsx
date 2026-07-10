import { useState, type KeyboardEvent } from 'react'
import logo from '../assets/logo.png'

interface Props {
  groups: Array<{ name: string; count: number }>
  allCount: number
  active: string // '' = all, '#ungrouped' = no group, else group name
  onSelect: (key: string) => void
  onProxy: () => void
  onSettings: () => void
  onOpenSite: () => void
  onCreateGroup: (name: string) => void
  onDeleteGroup: (name: string) => void
}

export function Sidebar({
  groups,
  allCount,
  active,
  onSelect,
  onProxy,
  onSettings,
  onOpenSite,
  onCreateGroup,
  onDeleteGroup
}: Props): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const submitGroup = (): void => {
    const n = newName.trim()
    if (n) onCreateGroup(n)
    setNewName('')
    setCreating(false)
  }
  const onGroupKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') submitGroup()
    else if (e.key === 'Escape') {
      setNewName('')
      setCreating(false)
    }
  }

  const Item = ({ k, label, count }: { k: string; label: string; count: number }): JSX.Element => (
    <button
      className={`nav-item ${active === k ? 'active' : ''}`}
      onClick={() => onSelect(k)}
    >
      <span className="nav-label">{label}</span>
      <span className="nav-count">{count}</span>
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="logo" src={logo} alt="VGC" style={{ width: 28, height: 28 }} />
        <div>
          <div className="brand-name">VGC Browser</div>
          <div className="brand-sub">Antidetect · VGC Group</div>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-title">Profiles</div>
        <Item k="" label="Tất cả" count={allCount} />
      </div>

      <div className="nav-section">
        <div
          className="nav-title"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>Nhóm</span>
          <span
            onClick={() => setCreating(true)}
            title="Tạo nhóm mới"
            style={{ cursor: 'pointer', color: 'var(--accent)', fontSize: 17, lineHeight: 1, fontWeight: 700 }}
          >
            ＋
          </span>
        </div>
        {creating && (
          <input
            autoFocus
            placeholder="Tên nhóm… (Enter)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={onGroupKey}
            onBlur={submitGroup}
            style={{
              width: '100%',
              margin: '2px 0 8px',
              padding: '8px 10px',
              background: 'var(--panel-2)',
              border: '1px solid var(--accent)',
              borderRadius: 7,
              color: 'var(--text)',
              outline: 'none',
              fontSize: 13
            }}
          />
        )}
        <div className="nav-scroll">
          {groups.length === 0 && (
            <div className="hint" style={{ padding: '2px 10px' }}>
              Chưa có nhóm. Bấm ＋ để tạo.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.name} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                className={`nav-item ${active === g.name ? 'active' : ''}`}
                style={{ flex: 1 }}
                onClick={() => onSelect(g.name)}
              >
                <span className="nav-label">{g.name}</span>
                <span className="nav-count">{g.count}</span>
              </button>
              <button
                title="Xoá nhóm"
                onClick={() => onDeleteGroup(g.name)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--dim)',
                  cursor: 'pointer',
                  padding: '0 6px',
                  fontSize: 13
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-bottom">
        <button className="nav-btn" onClick={onOpenSite}>
          🛒 <span>OpenSite Dashboard</span>
        </button>
        <button className="nav-btn" onClick={onProxy}>
          📡 <span>Proxy Manager</span>
        </button>
        <button className="nav-btn" onClick={onSettings}>
          ⚙ <span>Cài đặt</span>
        </button>
      </div>
    </aside>
  )
}
