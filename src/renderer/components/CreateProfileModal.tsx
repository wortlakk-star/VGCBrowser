import { useEffect, useState } from 'react'
import type { OsType, ProxyConfig, ProxyProviderId, SavedProxy } from '../../shared/types'
import { parseLine } from '../lib/proxy-parse'

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

type ProxyMode = 'none' | 'manual' | 'pool' | 'generate'
const PROXY_MODES: Array<{ v: ProxyMode; label: string }> = [
  { v: 'none', label: 'Không dùng' },
  { v: 'manual', label: '⌨ Nhập tay' },
  { v: 'pool', label: '📦 Lấy từ kho' },
  { v: 'generate', label: '✨ Tạo mới' }
]
const PROVIDERS: Array<[ProxyProviderId, string]> = [
  ['evomi', 'Evomi (residential)'],
  ['iproyal', 'iProyal (residential)'],
  ['cliproxy', 'Cliproxy']
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
  const [err, setErr] = useState('')

  // ── Proxy ──
  const [proxyMode, setProxyMode] = useState<ProxyMode>('none')
  const [manualText, setManualText] = useState('')
  const [pool, setPool] = useState<SavedProxy[]>([])
  const [poolId, setPoolId] = useState('') // specific pool proxy (count === 1)
  const [genProvider, setGenProvider] = useState<ProxyProviderId>('evomi')
  const [genCountry, setGenCountry] = useState('us')
  const [genProtocol, setGenProtocol] = useState<'http' | 'socks5'>('socks5')

  useEffect(() => {
    void window.vgc
      .listProxies()
      .then(setPool)
      .catch(() => {})
  }, [])

  const freeProxies = pool.filter((p) => !p.assignedTo)
  const cfgOf = (sp: SavedProxy | Omit<SavedProxy, 'id' | 'label'>): ProxyConfig => ({
    type: sp.type,
    host: sp.host,
    port: sp.port,
    username: sp.username,
    password: sp.password
  })

  const create = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const n = Math.max(1, Math.min(100, count || 1))
      const startUrls = url.trim() ? [url.trim()] : []

      // One proxy (config) per profile + the pool row to mark assigned (pool/generate modes).
      const configs: Array<ProxyConfig | null> = Array(n).fill(null)
      const poolRows: Array<SavedProxy | null> = Array(n).fill(null)
      let warning = '' // non-fatal shortfall (some profiles got no proxy) — shown, modal stays open

      if (proxyMode === 'manual') {
        const lines = manualText
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
        // Parse each line IN PLACE (no compacting) so line i maps to profile i — a bad line must
        // not shift every later line onto the wrong profile (which would duplicate an IP).
        const parsedLines = lines.map((l) => parseLine(l, 'socks5'))
        if (n === 1) {
          const first = parsedLines.find(Boolean)
          if (!first) {
            setErr('Không đọc được proxy. Định dạng: host:port:user:pass (hoặc user:pass@host:port).')
            return
          }
          configs[0] = cfgOf(first)
        } else {
          const badLines = parsedLines.map((p, i) => (!p ? i + 1 : 0)).filter((x) => x > 0)
          if (badLines.length) {
            setErr(`Dòng không đọc được: ${badLines.join(', ')} — sửa lại (mỗi dòng 1 proxy đúng định dạng).`)
            return
          }
          if (parsedLines.length < n) {
            setErr(`Cần ${n} dòng proxy (mỗi profile 1 proxy), mới có ${parsedLines.length}.`)
            return
          }
          for (let i = 0; i < n; i++) configs[i] = cfgOf(parsedLines[i] as NonNullable<(typeof parsedLines)[number]>)
        }
      } else if (proxyMode === 'pool') {
        const chosen =
          n === 1 && poolId
            ? [pool.find((p) => p.id === poolId)].filter((x): x is SavedProxy => !!x)
            : freeProxies.slice(0, n)
        if (!chosen.length) {
          setErr('Kho không còn proxy rảnh. Thêm proxy ở "Quản lý proxy" trước.')
          return
        }
        for (let i = 0; i < n; i++) {
          if (chosen[i]) {
            configs[i] = cfgOf(chosen[i])
            poolRows[i] = chosen[i]
          }
        }
        if (chosen.length < n)
          warning = `Chỉ còn ${chosen.length} proxy rảnh — ${n - chosen.length} profile sẽ không có proxy.`
      } else if (proxyMode === 'generate') {
        const created = await window.vgc.generateProviderProxies({
          provider: genProvider,
          product: genProvider === 'evomi' ? 'rpc' : undefined,
          count: n,
          country: genCountry.trim().toLowerCase(),
          protocol: genProtocol,
          sticky: true,
          lifetime: '24h',
          label: `${name.trim() || 'Profile'}`
        })
        if (!created.length) {
          setErr('Tạo proxy thất bại — kiểm tra API key nhà cung cấp trong Cài đặt → Nhà cung cấp Proxy.')
          return
        }
        for (let i = 0; i < n; i++) {
          if (created[i]) {
            configs[i] = cfgOf(created[i])
            poolRows[i] = created[i]
          }
        }
        if (created.length < n)
          warning = `Nhà cung cấp chỉ tạo được ${created.length}/${n} proxy — ${n - created.length} profile sẽ không có proxy.`
      }

      // Create the profiles (with their proxy) + mark the pool row assigned to each.
      for (let i = 0; i < n; i++) {
        const nm = n > 1 ? `${name.trim() || 'Profile'} ${i + 1}` : name.trim() || 'Profile mới'
        const p = await window.vgc.createProfile({
          name: nm,
          os,
          group: group || undefined,
          startUrls,
          proxy: configs[i] ?? { type: 'none' }
        })
        if (poolRows[i]) {
          try {
            await window.vgc.saveProxy({ ...(poolRows[i] as SavedProxy), assignedTo: p.id })
          } catch {
            /* pool bookkeeping only — never fail a create over it */
          }
        }
      }
      onCreated()
      // A shortfall (fewer proxies than profiles) is non-fatal — the profiles are created, but
      // keep the modal open showing the warning so the user isn't left thinking every profile
      // got a proxy. Otherwise close as normal.
      if (warning) setErr(warning)
      else onClose()
    } catch (e) {
      setErr(`Lỗi: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540 }}>
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

            {/* ── Proxy ── */}
            <label style={{ marginTop: 14 }}>Proxy</label>
            <div className="seg" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PROXY_MODES.map((m) => (
                <button
                  key={m.v}
                  className={`seg-btn ${proxyMode === m.v ? 'active' : ''}`}
                  onClick={() => setProxyMode(m.v)}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {proxyMode === 'manual' && (
              <div style={{ marginTop: 8 }}>
                <textarea
                  rows={count > 1 ? 4 : 2}
                  placeholder={
                    'host:port:user:pass   (hoặc user:pass@host:port)\n' +
                    (count > 1 ? 'Mỗi dòng 1 proxy — dòng i gán cho profile i.' : '')
                  }
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  style={{ width: '100%', fontFamily: 'ui-monospace,Consolas,monospace' }}
                />
                <p className="hint">
                  Hỗ trợ host:port:user:pass · user:pass@host:port · socks5://… (mặc định SOCKS5).
                </p>
              </div>
            )}

            {proxyMode === 'pool' && (
              <div style={{ marginTop: 8 }}>
                {count === 1 ? (
                  <select
                    className="group-select"
                    style={{ width: '100%' }}
                    value={poolId}
                    onChange={(e) => setPoolId(e.target.value)}
                  >
                    <option value="">— Tự lấy 1 proxy rảnh —</option>
                    {freeProxies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} ({p.type} {p.host}:{p.port})
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="hint">
                    Sẽ tự lấy <b>{Math.min(count, freeProxies.length)}</b> proxy rảnh gán cho {count}{' '}
                    profile.
                  </p>
                )}
                <p className="hint">
                  Kho đang có <b>{freeProxies.length}</b> proxy rảnh
                  {freeProxies.length < count ? ' — không đủ cho tất cả profile.' : '.'}
                </p>
              </div>
            )}

            {proxyMode === 'generate' && (
              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ margin: 0 }}>
                  Nhà cung cấp
                  <select
                    className="group-select"
                    style={{ width: '100%', marginTop: 4 }}
                    value={genProvider}
                    onChange={(e) => setGenProvider(e.target.value as ProxyProviderId)}
                  >
                    {PROVIDERS.map(([id, lbl]) => (
                      <option key={id} value={id}>
                        {lbl}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ margin: 0 }}>
                  Nước (ISO-2)
                  <input
                    value={genCountry}
                    onChange={(e) => setGenCountry(e.target.value)}
                    placeholder="us, vn, gb…"
                  />
                </label>
                <label style={{ margin: 0 }}>
                  Giao thức
                  <select
                    className="group-select"
                    style={{ width: '100%', marginTop: 4 }}
                    value={genProtocol}
                    onChange={(e) => setGenProtocol(e.target.value as 'http' | 'socks5')}
                  >
                    <option value="socks5">SOCKS5</option>
                    <option value="http">HTTP</option>
                  </select>
                </label>
                <p className="hint" style={{ alignSelf: 'end', margin: 0 }}>
                  Sẽ tạo <b>{count}</b> proxy sticky và gán mỗi profile 1 cái. Cần API key trong Cài
                  đặt. Tốn traffic/tiền nhà cung cấp.
                </p>
              </div>
            )}

            <label style={{ marginTop: 14 }}>
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
            {err && (
              <p className="hint" style={{ color: '#ff9a9a' }}>
                {err}
              </p>
            )}
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
