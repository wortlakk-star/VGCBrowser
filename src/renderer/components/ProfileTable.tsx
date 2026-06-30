import { useEffect, useState } from 'react'
import type { Profile, ProfileStatus, SavedProxy } from '../../shared/types'

interface Props {
  profiles: Profile[]
  statuses: Record<string, ProfileStatus>
  proxyPool: SavedProxy[]
  groups: string[]
  selected: Set<string>
  allSelected: boolean
  onToggleSelect: (id: string) => void
  onToggleSelectAll: () => void
  onRun: (id: string) => void
  onStop: (id: string) => void
  onCheck: (id: string) => void
  onLoginClean?: (id: string) => void
  onEdit: (p: Profile) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onMoveGroup: (id: string, group: string) => void
}

const STATUS_LABEL: Record<ProfileStatus, string> = {
  stopped: 'Đang tắt',
  starting: 'Đang mở…',
  running: 'Đang chạy',
  error: 'Lỗi'
}

/** Pull the Chrome major version out of a UA string for a compact summary. */
function browserSummary(ua: string): string {
  const m = ua.match(/Chrome\/(\d+)/)
  return m ? `Chrome ${m[1]}` : 'Chromium'
}

/** Shorten the verbose ANGLE renderer string to the GPU name. */
function gpuSummary(renderer: string): string {
  const m = renderer.match(/ANGLE \([^,]+, ([^,]+?) (?:Direct3D|vs_|D3D)/)
  return m ? m[1] : renderer.slice(0, 30)
}

/** Rough country flag from an IANA timezone. */
function tzFlag(tz: string): string {
  const exact: Record<string, string> = {
    'Europe/London': '🇬🇧',
    'Europe/Berlin': '🇩🇪',
    'Europe/Paris': '🇫🇷',
    'Asia/Singapore': '🇸🇬',
    'Asia/Ho_Chi_Minh': '🇻🇳',
    'Asia/Tokyo': '🇯🇵'
  }
  if (exact[tz]) return exact[tz]
  const region = tz.split('/')[0]
  if (region === 'America') return '🇺🇸'
  if (region === 'Europe') return '🇪🇺'
  if (region === 'Asia') return '🌏'
  return '🌐'
}

/** Proxy status line (IP + country, or "no proxy" / error). */
function proxyInfo(p: Profile, proxyPool: SavedProxy[]): JSX.Element {
  if (!p.proxy || p.proxy.type === 'none' || !p.proxy.host) {
    return (
      <span className="dim">
        <span className="pdot off" />Không proxy
      </span>
    )
  }
  const pc = p.proxyCheck
  if (pc?.status === 'ok' && pc.ip) {
    return (
      <span style={{ color: 'var(--green)' }}>
        <span className="pdot on" />
        {(pc.countryCode || '').toUpperCase()} · {pc.ip}
      </span>
    )
  }
  if (pc?.status === 'error') {
    return (
      <span style={{ color: 'var(--red)' }}>
        <span className="pdot off" />✗ proxy lỗi
      </span>
    )
  }
  const sp = proxyPool.find(
    (x) =>
      x.host === p.proxy.host &&
      x.port === p.proxy.port &&
      (x.username || '') === (p.proxy.username || '')
  )
  if (sp && sp.lastStatus === 'ok' && sp.lastIp) {
    return (
      <span style={{ color: 'var(--green)' }}>
        <span className="pdot on" />
        {(sp.lastCountryCode || '').toUpperCase()} · {sp.lastIp}
      </span>
    )
  }
  if (sp && sp.lastStatus === 'error') {
    return (
      <span style={{ color: 'var(--red)' }}>
        <span className="pdot off" />✗ proxy lỗi
      </span>
    )
  }
  return (
    <span>
      <span className="pdot on" />
      {p.proxy.host} <span className="dim">· chưa check</span>
    </span>
  )
}

export function ProfileTable({
  profiles,
  statuses,
  proxyPool,
  groups,
  selected,
  allSelected,
  onToggleSelect,
  onToggleSelectAll,
  onRun,
  onStop,
  onCheck,
  onEdit,
  onDuplicate,
  onDelete,
  onMoveGroup
}: Props): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null)

  // Close the ⋯ menu on any outside click.
  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor])

  return (
    <div className="profile-pane">
      <div className="grid-toolbar">
        <label className="select-all">
          <input type="checkbox" checked={allSelected} onChange={onToggleSelectAll} />
          Chọn tất cả
        </label>
        <span className="dim">{profiles.length} profile</span>
      </div>

      <div className="profile-grid">
        {profiles.map((p) => {
          const status = statuses[p.id] ?? 'stopped'
          const active = status === 'running' || status === 'starting'
          const sel = selected.has(p.id)
          return (
            <div key={p.id} className={`pcard${sel ? ' selected' : ''}`}>
              <div className="pcard-top">
                <input
                  type="checkbox"
                  checked={sel}
                  onChange={() => onToggleSelect(p.id)}
                />
                <span className={`pcard-dot ${status}`} title={STATUS_LABEL[status]} />
                <div className="pcard-title">
                  <div className="name">{p.name}</div>
                  {p.group && <span className="group-tag">{p.group}</span>}
                </div>
                <div className="pcard-menu-wrap">
                  <button
                    className="icon-btn"
                    title="Thêm hành động"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuFor(menuFor === p.id ? null : p.id)
                    }}
                  >
                    ⋯
                  </button>
                  {menuFor === p.id && (
                    <div className="pcard-menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => {
                          onCheck(p.id)
                          setMenuFor(null)
                        }}
                      >
                        🧪 Kiểm tra fingerprint
                      </button>
                      <button
                        onClick={() => {
                          onEdit(p)
                          setMenuFor(null)
                        }}
                      >
                        ✏️ Sửa
                      </button>
                      <button
                        onClick={() => {
                          onDuplicate(p.id)
                          setMenuFor(null)
                        }}
                      >
                        ⧉ Nhân bản
                      </button>
                      <div className="menu-sep" />
                      <label className="menu-group">
                        <span>Nhóm</span>
                        <select
                          value={p.group ?? ''}
                          onChange={(e) => onMoveGroup(p.id, e.target.value)}
                        >
                          <option value="">Tất cả (bỏ nhóm)</option>
                          {groups.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="menu-sep" />
                      <button
                        className="danger"
                        onClick={() => {
                          onDelete(p.id)
                          setMenuFor(null)
                        }}
                      >
                        🗑 Xoá profile
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="pcard-meta">
                <div className="pcard-row">
                  <span className="ico">💻</span>
                  <span className="mono">
                    {p.os} · {browserSummary(p.fingerprint?.userAgent ?? '')}
                  </span>
                </div>
                <div className="pcard-row dim">
                  <span className="ico" />
                  <span className="mono">
                    {gpuSummary(p.fingerprint?.webgl?.renderer ?? '')} ·{' '}
                    {p.fingerprint?.screen?.width ?? '?'}×{p.fingerprint?.screen?.height ?? '?'} ·{' '}
                    {p.fingerprint?.hardwareConcurrency ?? '?'} cores
                  </span>
                </div>
                <div className="pcard-row">
                  <span className="ico">🌐</span>
                  <span className="mono">{proxyInfo(p, proxyPool)}</span>
                </div>
                <div className="pcard-row">
                  <span className="ico">{tzFlag(p.fingerprint.timezone)}</span>
                  <span className="mono">{p.fingerprint.timezone}</span>
                </div>
                {p.tags.length > 0 && (
                  <div className="tags">
                    {p.tags.map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="pcard-foot">
                <span className={`status ${status}`}>{STATUS_LABEL[status]}</span>
                {active ? (
                  <button className="btn block" onClick={() => onStop(p.id)}>
                    ■ Dừng
                  </button>
                ) : (
                  <button className="btn primary block" onClick={() => onRun(p.id)}>
                    ▸ Mở
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
