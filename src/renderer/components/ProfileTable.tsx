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
  onEdit: (p: Profile) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onMoveGroup: (id: string, group: string) => void
}

const STATUS_LABEL: Record<ProfileStatus, string> = {
  stopped: 'Dừng',
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
  return m ? m[1] : renderer.slice(0, 28)
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
  return (
    <table className="profiles">
      <thead>
        <tr>
          <th className="check-col">
            <input type="checkbox" checked={allSelected} onChange={onToggleSelectAll} />
          </th>
          <th>Tên</th>
          <th>OS</th>
          <th>Fingerprint</th>
          <th>Proxy</th>
          <th>Timezone</th>
          <th>Trạng thái</th>
          <th className="actions-col">Hành động</th>
        </tr>
      </thead>
      <tbody>
        {profiles.map((p) => {
          const status = statuses[p.id] ?? 'stopped'
          const active = status === 'running' || status === 'starting'
          return (
            <tr key={p.id} className={selected.has(p.id) ? 'selected' : undefined}>
              <td className="check-col">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => onToggleSelect(p.id)}
                />
              </td>
              <td>
                <div className="name">{p.name}</div>
                {p.group && <div className="group-tag">{p.group}</div>}
                {p.tags.length > 0 && (
                  <div className="tags">
                    {p.tags.map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="mono">{p.os}</td>
              <td>
                <div className="fp">{browserSummary(p.fingerprint.userAgent)}</div>
                <div className="fp dim">{gpuSummary(p.fingerprint.webgl.renderer)}</div>
                <div className="fp dim">
                  {p.fingerprint.screen.width}×{p.fingerprint.screen.height} ·{' '}
                  {p.fingerprint.hardwareConcurrency} cores
                </div>
              </td>
              <td className="mono small">
                {(() => {
                  if (p.proxy.type === 'none' || !p.proxy.host) {
                    return (
                      <>
                        <span className="pdot off" />— (không proxy)
                      </>
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
                    <>
                      <span className="pdot on" />
                      {p.proxy.host} <span className="dim">· chưa check</span>
                    </>
                  )
                })()}
              </td>
              <td className="mono small">
                {tzFlag(p.fingerprint.timezone)} {p.fingerprint.timezone}
              </td>
              <td>
                <span className={`status ${status}`}>{STATUS_LABEL[status]}</span>
              </td>
              <td className="actions-col">
                {active ? (
                  <button className="btn" onClick={() => onStop(p.id)}>
                    Dừng
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => onRun(p.id)}>
                    Mở
                  </button>
                )}
                <button
                  className="btn"
                  title="Mở creepjs trong profile để đối chiếu fingerprint"
                  onClick={() => onCheck(p.id)}
                >
                  Kiểm tra
                </button>
                <button className="btn" onClick={() => onEdit(p)}>
                  Sửa
                </button>
                <select
                  className="group-select"
                  title="Chuyển vào nhóm"
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
                <button className="btn" title="Nhân bản" onClick={() => onDuplicate(p.id)}>
                  Nhân bản
                </button>
                <button className="btn danger" onClick={() => onDelete(p.id)}>
                  Xoá
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
