import { useEffect, useState, type CSSProperties } from 'react'
import type { AccountStatus, Profile, ProfileStatus, SavedProxy } from '../../shared/types'

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
  /** Open the proxy picker (choose existing / paste new / generate) for this profile. */
  onOpenProxyPicker: (profile: Profile) => void
  /** Set the account health status ('' = clear). */
  onSetAccountStatus: (id: string, status: AccountStatus | '') => void
}

const STATUS_LABEL: Record<ProfileStatus, string> = {
  stopped: 'Sẵn sàng',
  starting: 'Đang mở…',
  running: 'Đang chạy',
  error: 'Lỗi'
}

const ACCT_STATUS: Record<AccountStatus, { label: string; cls: string }> = {
  live: { label: 'Live', cls: 'live' },
  ready: { label: 'Sẵn sàng', cls: 'ready' },
  die: { label: 'Die', cls: 'die' },
  banned: { label: 'Banned', cls: 'banned' }
}
const ACCT_ORDER: AccountStatus[] = ['live', 'ready', 'die', 'banned']

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
      (x.username || '') === (p.proxy.username || '') &&
      (x.password || '') === (p.proxy.password || '')
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
  onMoveGroup,
  onOpenProxyPicker,
  onSetAccountStatus
}: Props): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const [checkingProxy, setCheckingProxy] = useState<Set<string>>(new Set())

  // Position the ⋯ menu relative to the button's on-screen rect (position: fixed, so
  // it escapes the table's overflow) and FLIP IT UP when there isn't enough room below
  // — otherwise bottom-row menus render off the bottom of the window and can't be used.
  const openMenu = (id: string, btn: HTMLElement): void => {
    const rect = btn.getBoundingClientRect()
    const MENU_W = 230
    const EST_H = 360 // approx full menu height; used only to decide flip direction
    const left = Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8))
    const spaceBelow = window.innerHeight - rect.bottom
    const flipUp = spaceBelow < EST_H && rect.top > spaceBelow
    setMenuStyle(
      flipUp
        ? { position: 'fixed', left, right: 'auto', top: 'auto', bottom: window.innerHeight - rect.top + 6 }
        : { position: 'fixed', left, right: 'auto', bottom: 'auto', top: rect.bottom + 6 }
    )
    setMenuFor(id)
  }

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

  // Close the ⋯ menu on any outside click, or on scroll/resize (its fixed position is
  // a snapshot of the button's rect, so it must close when the layout moves under it).
  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    document.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
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
                  <div className="pname">
                    {p.name}
                    {p.account?.status && (
                      <span className={`acct-pill ${ACCT_STATUS[p.account.status].cls}`}>
                        {ACCT_STATUS[p.account.status].label}
                      </span>
                    )}
                  </div>
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
                    <button
                      className="proxy-check-btn"
                      title="Chọn / đổi / thêm proxy (có sẵn · nhập tay · mua mới)"
                      onClick={() => onOpenProxyPicker(p)}
                    >
                      +
                    </button>
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
                          if (menuFor === p.id) setMenuFor(null)
                          else openMenu(p.id, e.currentTarget)
                        }}
                      >
                        ⋯
                      </button>
                      {menuFor === p.id && (
                        <div
                          className="row-menu"
                          style={menuStyle}
                          onClick={(e) => e.stopPropagation()}
                        >
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
                          <label className="menu-group">
                            <span>Trạng thái</span>
                            <select
                              value={p.account?.status ?? ''}
                              onChange={(e) =>
                                onSetAccountStatus(p.id, e.target.value as AccountStatus | '')
                              }
                            >
                              <option value="">— chưa đặt —</option>
                              {ACCT_ORDER.map((s) => (
                                <option key={s} value={s}>
                                  {ACCT_STATUS[s].label}
                                </option>
                              ))}
                            </select>
                          </label>
                          {p.account?.totp && (
                            <button
                              onClick={() => {
                                const secret = p.account?.totp
                                if (secret)
                                  void window.vgc.totpNow(secret).then((code) => {
                                    if (code) void navigator.clipboard?.writeText(code)
                                  })
                                setMenuFor(null)
                              }}
                            >
                              🔑 Copy mã 2FA
                            </button>
                          )}
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
