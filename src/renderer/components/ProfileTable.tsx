import { useEffect, useState, type CSSProperties } from 'react'
import type { AccountStatus, Profile, ProfileStatus, SavedProxy } from '../../shared/types'
import { Icon, flagEmoji, timeAgo } from './Icon'

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

/** Deterministic avatar colour per profile (pleasant hues, brand-adjacent). */
const AVATAR_HUES = [214, 199, 187, 232, 262, 168, 206, 246, 180, 224]
function avatarStyle(id: string): CSSProperties {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const hue = AVATAR_HUES[h % AVATAR_HUES.length]
  return {
    ['--av-bg' as string]: `linear-gradient(135deg, hsl(${hue} 78% 56%), hsl(${(hue + 28) % 360} 82% 46%))`
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s—–-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? '?'
  const b = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (a + b).toUpperCase()
}

function osIcon(os: string): string {
  return os === 'macos' ? 'laptop' : os === 'android' ? 'wifi' : 'monitor'
}

function osLabel(os: string): string {
  return os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'android' ? 'Android' : os
}

/** Proxy status line (flag + country + IP + latency, or "no proxy" / error). */
function proxyInfo(p: Profile, proxyPool: SavedProxy[]): JSX.Element {
  if (!p.proxy || p.proxy.type === 'none' || !p.proxy.host) {
    return (
      <span className="proxy-none">
        <Icon name="globe" size={14} />
        Không proxy
      </span>
    )
  }
  // Flag emoji only where the OS can draw them (macOS). Windows has no flag glyphs — it
  // would print the two regional-indicator letters, so there we show a country badge.
  const mac = /Mac/i.test(navigator.platform)
  const line = (cc: string | undefined, ip: string | undefined, ms?: number): JSX.Element => (
    <span className="proxy-line proxy-ok">
      {mac && flagEmoji(cc) ? (
        <span className="flag">{flagEmoji(cc)}</span>
      ) : (
        <span className="cc">{(cc || '').toUpperCase() || '??'}</span>
      )}
      <span className="ip">{ip}</span>
      {typeof ms === 'number' && ms > 0 && (
        <span className={`latency ${ms > 400 ? 'slow' : ''}`}>{ms} ms</span>
      )}
    </span>
  )
  const pc = p.proxyCheck
  if (pc?.status === 'ok' && pc.ip) return line(pc.countryCode, pc.ip, pc.latencyMs)
  if (pc?.status === 'error') {
    return (
      <span className="proxy-err">
        <Icon name="alert" size={14} />
        Proxy lỗi
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
  if (sp && sp.lastStatus === 'ok' && sp.lastIp) return line(sp.lastCountryCode, sp.lastIp, sp.latencyMs)
  if (sp && sp.lastStatus === 'error') {
    return (
      <span className="proxy-err">
        <Icon name="alert" size={14} />
        Proxy lỗi
      </span>
    )
  }
  return (
    <span className="proxy-line">
      <span className="pdot on" />
      <span className="ip">{p.proxy.host}</span>
      <span className="dim small">· chưa check</span>
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
    const MENU_W = 240
    const EST_H = 380 // approx full menu height; used only to decide flip direction
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
            <th className="col-name">Profile</th>
            <th className="col-status">Trạng thái</th>
            <th className="col-proxy">Proxy &amp; vị trí</th>
            <th className="col-used">Dùng gần đây</th>
            <th className="col-act" />
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => {
            const status = statuses[p.id] ?? 'stopped'
            const active = status === 'running' || status === 'starting'
            const sel = selected.has(p.id)
            const used = timeAgo(p.lastUsedAt)
            const recent = !!p.lastUsedAt && Date.now() - Date.parse(p.lastUsedAt) < 86_400_000
            return (
              <tr key={p.id} className={`${sel ? 'sel' : ''} ${status === 'running' ? 'running' : ''}`}>
                <td className="col-check">
                  <input type="checkbox" checked={sel} onChange={() => onToggleSelect(p.id)} />
                </td>
                <td className="col-name">
                  <div className="pcell">
                    <div className="pavatar" style={avatarStyle(p.id)}>
                      {initials(p.name)}
                      <span className="os-badge" title={osLabel(p.os)}>
                        <Icon name={osIcon(p.os)} size={11} strokeWidth={2.2} />
                      </span>
                    </div>
                    <div className="ptext">
                      <div className="pname">
                        <span title={p.name}>{p.name}</span>
                        {p.account?.status && ACCT_STATUS[p.account.status] && (
                          <span
                            className={`acct-pill ${ACCT_STATUS[p.account.status].cls}`}
                            title={`Tài khoản: ${ACCT_STATUS[p.account.status].label}`}
                          >
                            {ACCT_STATUS[p.account.status].label}
                          </span>
                        )}
                      </div>
                      <div className="psub">
                        <span>{browserSummary(p.fingerprint?.userAgent ?? '')}</span>
                        {p.account?.user && (
                          <>
                            <span className="sep">·</span>
                            <span title={p.account.user}>{p.account.user}</span>
                          </>
                        )}
                        {p.group && (
                          <span className="pgroup">
                            <Icon name="folder" size={10} />
                            {p.group}
                          </span>
                        )}
                      </div>
                    </div>
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
                    <span className="proxy-tools">
                      {p.proxy && p.proxy.type !== 'none' && p.proxy.host && (
                        <button
                          className={`proxy-check-btn${checkingProxy.has(p.id) ? ' spinning' : ''}`}
                          title="Kiểm tra proxy (IP + vị trí)"
                          disabled={checkingProxy.has(p.id)}
                          onClick={() => void runProxyCheck(p.id)}
                        >
                          <Icon name="refresh" size={13} strokeWidth={2.2} />
                        </button>
                      )}
                      <button
                        className="proxy-check-btn"
                        title="Chọn / đổi / thêm proxy (có sẵn · nhập tay · mua mới)"
                        onClick={() => onOpenProxyPicker(p)}
                      >
                        <Icon name="plus" size={13} strokeWidth={2.4} />
                      </button>
                    </span>
                  </div>
                </td>
                <td className="col-used">
                  <span className={`last-used ${recent ? 'recent' : ''}`}>{used}</span>
                </td>
                <td className="col-act">
                  <div className="row-actions">
                    {active ? (
                      <button className="run-btn stop" title="Dừng profile" onClick={() => onStop(p.id)}>
                        <Icon name="stop" size={13} strokeWidth={2.4} />
                        Dừng
                      </button>
                    ) : (
                      <button className="run-btn" title="Chạy profile" onClick={() => onRun(p.id)}>
                        <Icon name="play" size={13} strokeWidth={2.4} />
                        Chạy
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
                        <Icon name="more" size={18} strokeWidth={2.6} />
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
                            <Icon name="globe" size={16} />
                            Kiểm tra proxy
                          </button>
                          <button
                            onClick={() => {
                              onCheck(p.id)
                              setMenuFor(null)
                            }}
                          >
                            <Icon name="fingerprint" size={16} />
                            Kiểm tra fingerprint
                          </button>
                          <button
                            onClick={() => {
                              onEdit(p)
                              setMenuFor(null)
                            }}
                          >
                            <Icon name="edit" size={16} />
                            Sửa profile
                          </button>
                          <button
                            onClick={() => {
                              onDuplicate(p.id)
                              setMenuFor(null)
                            }}
                          >
                            <Icon name="copy" size={16} />
                            Nhân bản
                          </button>
                          <button
                            onClick={() => {
                              onShare(p)
                              setMenuFor(null)
                            }}
                          >
                            <Icon name="share" size={16} />
                            Chia sẻ
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
                              <Icon name="key" size={16} />
                              Copy mã 2FA
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
                            <Icon name="trash" size={16} />
                            Xoá profile
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
