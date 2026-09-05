import { useState, type KeyboardEvent } from 'react'
import logo from '../assets/logo.png'
import { Icon } from './Icon'
import type { Theme } from '../theme'

interface Props {
  email: string
  profileCount: number
  runningCount: number
  groups: Array<{ name: string; count: number }>
  allCount: number
  active: string // '' = all, '#ungrouped' = no group, else group name
  version?: string
  theme: Theme
  onToggleTheme: () => void
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
  runningCount,
  groups,
  allCount,
  active,
  version,
  theme,
  onToggleTheme,
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
  const ungrouped = Math.max(0, allCount - groups.reduce((n, g) => n + g.count, 0))
  const usagePct = Math.min(100, Math.round((profileCount / Math.max(profileCount, 50)) * 100))

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="side-brand">
        <img className="side-brand-logo" src={logo} alt="VGC" />
        <span className="side-brand-name">VGC Browser</span>
        {version && <span className="side-brand-ver">v{version}</span>}
      </div>

      {/* Account */}
      <div className="acct" title={acctName} onClick={onSettings}>
        <div className="acct-av">{initial}</div>
        <div className="acct-info">
          <div className="acct-name">{acctName}</div>
          <div className="acct-plan">Antidetect · VGC Group</div>
        </div>
        <span className="acct-chev">
          <Icon name="chevron-down" size={16} />
        </span>
      </div>

      {/* Primary action */}
      <button className="add-profile" onClick={onCreate}>
        <Icon name="plus" size={18} strokeWidth={2.4} />
        Tạo profile mới
      </button>

      <nav className="nav">
        <button className={`nav-row ${active === '' ? 'active' : ''}`} onClick={() => onSelect('')}>
          <span className="nav-ic">
            <Icon name="grid" size={17} />
          </span>
          <span className="nav-lbl">Tất cả hồ sơ</span>
          <span className="nav-ct">{allCount}</span>
        </button>
        {ungrouped > 0 && groups.length > 0 && (
          <button
            className={`nav-row ${active === '#ungrouped' ? 'active' : ''}`}
            onClick={() => onSelect('#ungrouped')}
          >
            <span className="nav-ic">
              <Icon name="inbox" size={17} />
            </span>
            <span className="nav-lbl">Chưa phân nhóm</span>
            <span className="nav-ct">{ungrouped}</span>
          </button>
        )}

        <div className="nav-sec">
          <span>Nhóm</span>
          <button className="nav-add" title="Tạo nhóm mới" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} strokeWidth={2.4} />
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
            <div className="nav-empty">Chưa có nhóm. Bấm + để tạo.</div>
          )}
          {groups.map((g) => (
            <div className="nav-grouprow" key={g.name}>
              <button
                className={`nav-row ${active === g.name ? 'active' : ''}`}
                onClick={() => onSelect(g.name)}
              >
                <span className="nav-ic">
                  <Icon name="folder" size={16} />
                </span>
                <span className="nav-lbl">{g.name}</span>
                <span className="nav-ct">{g.count}</span>
              </button>
              <button className="nav-del" title="Xoá nhóm" onClick={() => onDeleteGroup(g.name)}>
                <Icon name="x" size={13} strokeWidth={2.4} />
              </button>
            </div>
          ))}
        </div>

        <div className="nav-divider" />
        <button className="nav-row" onClick={onProxy}>
          <span className="nav-ic">
            <Icon name="globe" size={17} />
          </span>
          <span className="nav-lbl">Kho proxy</span>
        </button>
      </nav>

      <div className="side-foot">
        <div className="plan-card">
          <div className="plan-head">
            <Icon name="shield" size={15} style={{ color: 'var(--accent-2)' }} />
            <span className="plan-title">VGC Antidetect</span>
            <span className="plan-count">{profileCount} hồ sơ</span>
          </div>
          <div className="plan-bar">
            <i style={{ width: `${usagePct}%` }} />
          </div>
          <div className="plan-meta">
            <span>
              <b>{runningCount}</b> đang chạy
            </span>
            <span>Đồng bộ cloud</span>
          </div>
        </div>
        <div className="side-actions">
          <button className="nav-row side-settings" onClick={onSettings}>
            <span className="nav-ic">
              <Icon name="settings" size={17} />
            </span>
            <span className="nav-lbl">Cài đặt</span>
          </button>
          <button
            className="nav-row theme-toggle"
            title={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}
            onClick={onToggleTheme}
          >
            <span className="nav-ic">
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
            </span>
          </button>
        </div>
      </div>
    </aside>
  )
}
