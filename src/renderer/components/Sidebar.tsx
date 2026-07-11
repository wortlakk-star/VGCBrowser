import { useState, type KeyboardEvent } from 'react'
import logo from '../assets/logo.png'

interface Props {
  email: string
  profileCount: number
  groups: Array<{ name: string; count: number }>
  allCount: number
  active: string // '' = all, '#ungrouped' = no group, else group name
  onSelect: (key: string) => void
  onCreate: () => void
  onProxy: () => void
  onSettings: () => void
  onCreateGroup: (name: string) => void
  onDeleteGroup: (name: string) => void
}

export function Sidebar({
  email,
  profileCount,
  groups,
  allCount,
  active,
  onSelect,
  onCreate,
  onProxy,
  onSettings,
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

  const acctName = email || 'VGC Browser'
  const initial = (email || 'V').trim().charAt(0).toUpperCase()

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="side-brand">
        <img className="side-brand-logo" src={logo} alt="VGC" />
        <span className="side-brand-name">VGC Browser</span>
      </div>

      {/* Account switcher (GoLogin-style) */}
      <div className="acct" title={acctName}>
        <div className="acct-av">{initial}</div>
        <div className="acct-info">
          <div className="acct-name">{acctName}</div>
          <div className="acct-plan">Antidetect · VGC Group</div>
        </div>
        <span className="acct-chev">⌄</span>
      </div>

      {/* Primary action */}
      <button className="add-profile" onClick={onCreate}>
        <span className="plus">＋</span> Thêm hồ sơ
      </button>

      <nav className="nav">
        <button
          className={`nav-row ${active === '' ? 'active' : ''}`}
          onClick={() => onSelect('')}
        >
          <span className="nav-ic">▦</span>
          <span className="nav-lbl">Tất cả hồ sơ</span>
          <span className="nav-ct">{allCount}</span>
        </button>

        <div className="nav-sec">
          <span>Nhóm</span>
          <button className="nav-add" title="Tạo nhóm mới" onClick={() => setCreating(true)}>
            ＋
          </button>
        </div>
        {creating && (
          <input
            className="group-input"
            autoFocus
            placeholder="Tên nhóm… (Enter)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={onGroupKey}
            onBlur={submitGroup}
          />
        )}
        <div className="nav-scroll">
          {groups.length === 0 && !creating && (
            <div className="nav-empty">Chưa có nhóm. Bấm ＋ để tạo.</div>
          )}
          {groups.map((g) => (
            <div className="nav-grouprow" key={g.name}>
              <button
                className={`nav-row ${active === g.name ? 'active' : ''}`}
                onClick={() => onSelect(g.name)}
              >
                <span className="nav-ic">▸</span>
                <span className="nav-lbl">{g.name}</span>
                <span className="nav-ct">{g.count}</span>
              </button>
              <button className="nav-del" title="Xoá nhóm" onClick={() => onDeleteGroup(g.name)}>
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="nav-divider" />
        <button className="nav-row" onClick={onProxy}>
          <span className="nav-ic">🛰</span>
          <span className="nav-lbl">Proxy</span>
        </button>
      </nav>

      <div className="side-foot">
        <div className="plan-card">
          <div className="plan-title">VGC Antidetect</div>
          <div className="plan-count">{profileCount} hồ sơ</div>
        </div>
        <button className="nav-row side-settings" onClick={onSettings}>
          <span className="nav-ic">⚙</span>
          <span className="nav-lbl">Cài đặt</span>
        </button>
      </div>
    </aside>
  )
}
