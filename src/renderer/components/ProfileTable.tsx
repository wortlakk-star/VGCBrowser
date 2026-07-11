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
  onCheckProxy: (id: string) => void | Promise<void>
  onLoginClean?: (id: string) => void
  onEdit: (p: Profile) => void
  onDuplicate: (id: string) => void
  onShare: (p: Profile) => void
  onDelete: (id: string) => void
  onMoveGroup: (id: string, group: string) => void
}

const STATUS_LABEL: Record<ProfileStatus, string> = {
  stopped: 'Sẵn sàng',
  starting: 'Đang mở…',
  running: 'Đang chạy',
  error: 'Lỗi'
}

/** Pull the Chrome major version out of a UA string for a compact summary. */
function browserSummary(ua: string): string {
  const m = ua.match(/Chrome\/(\d+)/)
  return m ? `Chrome ${m[1]}` : 'Chromium'
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
      <span className="proxy-ok">
        <span className="flag">{pc.countryCode ? '' : '🌐'}</span>
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
      <span className="proxy-ok">
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
  onCheckProxy,
  onEdit,
  onDuplicate,
  onShare,
  onDelete,
  onMoveGroup
}: Props): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [checkingProxy, setCheckingProxy] = useState<Set<string>>(new Set())

  const runProxyCheck = async (id: string): Promise<void> => {
    setCheckingProxy((s) => new Set(s).add(id))
    try {
      await onCheckProxy(id)
    } finally {
      setCheckingProxy((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    }
  }

  // Close the ⋯ menu on any outside click.
  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor])

  return (
    <div className="ptable-wrap">
      <table className="ptable">
        <thead>
          <tr>
            <th className="col-check">
              <input type="checkbox" checked={allSelected} onChange={onToggleSelectAll} />
            </th>
            <th className="col-name">Tên</th>
            <th className="col-status">Tình trạng</th>
            <th className="col-proxy">Proxy &amp; Vị trí</th>
            <th className="col-act" />
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => {
            const status = statuses[p.id] ?? 'stopped'
            const active = status === 'running' || status === 'starting'
            const sel = selected.has(p.id)
            return (
              <tr key={p.id} className={sel ? 'sel' : ''}>
                <td className="col-check">
                  <input type="checkbox" checked={sel} onChange={() => onToggleSelect(p.id)} />
                </td>
                <td className="col-name">
                  <div className="pname">{p.name}</div>
                  <div className="psub">
                    {p.os} · {browserSummary(p.fingerprint?.userAgent ?? '')}
                    {p.group && <span className="pgroup">{p.group}</span>}
                  </div>
                </td>
                <td className="col-status">
                  <span className={`pstatus ${status}`}>
                    <i className="sdot" />
                    {STATUS_LABEL[status]}
                  </span>
                </td>
                <td className="col-proxy">
                  <div className="proxy-cell">
                    <span className="mono">{proxyInfo(p, proxyPool)}</span>
                    {p.proxy && p.proxy.type !== 'none' && p.proxy.host && (
                      <button
                        className={`proxy-check-btn${checkingProxy.has(p.id) ? ' spinning' : ''}`}
                        title="Kiểm tra proxy (IP + vị trí)"
                        disabled={checkingProxy.has(p.id)}
                        onClick={() => void runProxyCheck(p.id)}
                      >
                        ↻
                      </button>
                    )}
                  </div>
                </td>
                <td className="col-act">
                  <div className="row-actions">
                    {active ? (
                      <button className="run-btn stop" onClick={() => onStop(p.id)}>
                        ■ Dừng
                      </button>
                    ) : (
                      <button className="run-btn" onClick={() => onRun(p.id)}>
                        ▸ Chạy
                      </button>
                    )}
                    <div className="menu-wrap">
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
                        <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => {
                              void runProxyCheck(p.id)
                              setMenuFor(null)
                            }}
                          >
                            🌐 Kiểm tra proxy
                          </button>
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
                          <button
                            onClick={() => {
                              onShare(p)
                              setMenuFor(null)
                            }}
                          >
                            🔗 Chia sẻ
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
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
