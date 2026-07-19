import { useState } from 'react'
import type { Profile, ProxyProviderId, SavedProxy } from '../../shared/types'
import { parseLine } from '../lib/proxy-parse'

interface Props {
  profile: Profile
  pool: SavedProxy[]
  /** Assign `sp` (or remove when null) to the profile — App owns the pool/assignedTo/check logic. */
  onApply: (profileId: string, sp: SavedProxy | null) => Promise<void>
  onClose: () => void
}

type Mode = 'pool' | 'manual' | 'generate'
const MODES: Array<{ v: Mode; label: string }> = [
  { v: 'pool', label: '📦 Có sẵn' },
  { v: 'manual', label: '⌨ Nhập tay' },
  { v: 'generate', label: '✨ Tạo/Mua mới' }
]
const PROVIDERS: Array<[ProxyProviderId, string]> = [
  ['evomi', 'Evomi (residential)'],
  ['iproyal', 'iProyal (residential)'],
  ['cliproxy', 'Cliproxy']
]
const genId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

/** The pool proxy this profile currently uses (matched by host/port/user), if any. */
function matchedPoolProxy(profile: Profile, pool: SavedProxy[]): SavedProxy | undefined {
  if (!profile.proxy || profile.proxy.type === 'none' || !profile.proxy.host) return undefined
  return pool.find(
    (x) =>
      x.host === profile.proxy.host &&
      x.port === profile.proxy.port &&
      (x.username || '') === (profile.proxy.username || '')
  )
}

export function ProxyPickerModal({ profile, pool, onApply, onClose }: Props): JSX.Element {
  const cur = matchedPoolProxy(profile, pool)
  const [mode, setMode] = useState<Mode>('pool')
  const [poolId, setPoolId] = useState<string>(cur ? cur.id : '')
  const [manualText, setManualText] = useState('')
  const [genProvider, setGenProvider] = useState<ProxyProviderId>('evomi')
  const [genCountry, setGenCountry] = useState('us')
  const [genProtocol, setGenProtocol] = useState<'http' | 'socks5'>('socks5')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Free pool proxies (plus the one already on this profile, so it stays selectable).
  const free = pool.filter((x) => !x.assignedTo || x.id === cur?.id)
  const hasEmbedded = !!(profile.proxy && profile.proxy.type !== 'none' && profile.proxy.host && !cur)

  const apply = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      let sp: SavedProxy | null = null
      if (mode === 'pool') {
        sp = poolId ? pool.find((x) => x.id === poolId) ?? null : null
      } else if (mode === 'manual') {
        const parsed = manualText
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => parseLine(l, 'socks5'))
          .find(Boolean)
        if (!parsed) {
          setErr('Không đọc được proxy. Định dạng: host:port:user:pass (hoặc user:pass@host:port).')
          return
        }
        // Add the new proxy to the pool (so it's reusable + shows its assignedTo), then assign it.
        sp = await window.vgc.saveProxy({
          id: genId(),
          label: `Nhập tay · ${parsed.host}`,
          type: parsed.type,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username,
          password: parsed.password
        })
      } else if (mode === 'generate') {
        const created = await window.vgc.generateProviderProxies({
          provider: genProvider,
          product: genProvider === 'evomi' ? 'rpc' : undefined,
          count: 1,
          country: genCountry.trim().toLowerCase(),
          protocol: genProtocol,
          sticky: true,
          lifetime: '24h',
          label: profile.name
        })
        if (!created.length) {
          setErr('Tạo proxy thất bại — kiểm tra API key nhà cung cấp trong Cài đặt → Nhà cung cấp Proxy.')
          return
        }
        sp = created[0]
      }
      await onApply(profile.id, sp)
      onClose()
    } catch (e) {
      setErr(`Lỗi: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <header className="modal-head">
          <h2>Proxy — {profile.name}</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <div className="seg" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {MODES.map((m) => (
                <button
                  key={m.v}
                  className={`seg-btn ${mode === m.v ? 'active' : ''}`}
                  onClick={() => setMode(m.v)}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {mode === 'pool' && (
              <div style={{ marginTop: 12 }}>
                <label>Chọn proxy trong kho</label>
                <select
                  className="group-select"
                  style={{ width: '100%', marginTop: 4 }}
                  value={poolId}
                  onChange={(e) => setPoolId(e.target.value)}
                >
                  <option value="">🚫 Bỏ proxy (chạy không proxy)</option>
                  {hasEmbedded && (
                    <option value="" disabled>
                      Hiện tại: {profile.proxy.host} (ngoài kho)
                    </option>
                  )}
                  {free.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.assignedTo === profile.id ? '✓ ' : ''}
                      {x.label} ({x.type} {x.host}:{x.port})
                    </option>
                  ))}
                </select>
                <p className="hint">Kho đang có {free.filter((x) => !x.assignedTo).length} proxy rảnh.</p>
              </div>
            )}

            {mode === 'manual' && (
              <div style={{ marginTop: 12 }}>
                <label>Dán proxy mới</label>
                <textarea
                  rows={2}
                  autoFocus
                  placeholder="host:port:user:pass  (hoặc user:pass@host:port · socks5://…)"
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  style={{ width: '100%', fontFamily: 'ui-monospace,Consolas,monospace' }}
                />
                <p className="hint">Proxy này sẽ được thêm vào kho + gán cho profile này.</p>
              </div>
            )}

            {mode === 'generate' && (
              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
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
                  <input value={genCountry} onChange={(e) => setGenCountry(e.target.value)} placeholder="us" />
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
                  Tạo 1 proxy mới qua API + gán ngay. Cần API key. Tốn traffic/tiền nhà cung cấp.
                </p>
              </div>
            )}

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
          <button className="btn primary" onClick={() => void apply()} disabled={busy}>
            {busy ? 'Đang áp dụng…' : 'Áp dụng'}
          </button>
        </footer>
      </div>
    </div>
  )
}
