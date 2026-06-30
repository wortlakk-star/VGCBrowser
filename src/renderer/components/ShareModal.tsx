import { useEffect, useState } from 'react'
import type { Profile, ProxyConfig, SavedProxy } from '../../shared/types'

interface Props {
  profile: Profile
  proxies: SavedProxy[]
  onClose: () => void
}

function savedToProxyConfig(p: SavedProxy): ProxyConfig {
  return {
    type: p.type,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password
  }
}

/** Share a profile (full login session, two-way) to another VGC account email,
 *  with a proxy the owner chooses for the shared copy. */
export function ShareModal({ profile, proxies, onClose }: Props): JSX.Element {
  const [email, setEmail] = useState('')
  const [proxyId, setProxyId] = useState('') // '' = keep the profile's own proxy
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [shares, setShares] = useState<Array<{ email: string }>>([])

  const loadShares = async (): Promise<void> => {
    setShares(await window.vgc.shareList(profile.id))
  }
  useEffect(() => {
    void loadShares()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doShare = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const chosen = proxies.find((p) => p.id === proxyId)
      const proxy: ProxyConfig | null = chosen ? savedToProxyConfig(chosen) : profile.proxy ?? null
      const res = await window.vgc.shareCreate(profile.id, email.trim(), proxy)
      if (!res.ok) {
        setMsg({ type: 'err', text: res.error ?? 'Chia sẻ thất bại' })
        return
      }
      await window.vgc.updateProfile(profile.id, {})
      void window.vgc.cloudUploadData(profile.id)
      setEmail('')
      setMsg({ type: 'ok', text: 'Đã chia sẻ. Người kia đăng nhập VGC bằng email đó sẽ thấy profile.' })
      await loadShares()
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const removeShare = async (em: string): Promise<void> => {
    await window.vgc.shareRemove(profile.id, em)
    await loadShares()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>🔗 Chia sẻ profile: {profile.name}</h3>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <p className="hint">
              Người nhận đăng nhập VGC bằng email được chia sẻ sẽ thấy profile này (đã đăng nhập sẵn),
              dùng proxy bạn chọn. Đồng bộ 2 chiều — đừng mở cùng lúc trên 2 máy.
            </p>

            <label>
              Email người nhận
              <input
                type="email"
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <label>
              Proxy cho bản chia sẻ
              <select value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
                <option value="">Giữ proxy của profile</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || `${p.host}:${p.port}`} ({p.type})
                  </option>
                ))}
              </select>
            </label>

            {msg && <p className={msg.type === 'ok' ? 'ok' : 'err'}>{msg.text}</p>}
          </section>

          {shares.length > 0 && (
            <section className="card">
              <h3>Đang chia sẻ với</h3>
              {shares.map((s) => (
                <div key={s.email} className="token-row">
                  <span className="mono small">{s.email}</span>
                  <button className="btn ghost" onClick={() => void removeShare(s.email)}>
                    Gỡ
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Đóng
          </button>
          <button
            className="btn primary"
            disabled={busy || !email.includes('@')}
            onClick={() => void doShare()}
          >
            {busy ? 'Đang chia sẻ…' : 'Chia sẻ'}
          </button>
        </footer>
      </div>
    </div>
  )
}
