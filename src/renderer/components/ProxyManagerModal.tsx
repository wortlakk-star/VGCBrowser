import { useEffect, useState } from 'react'
import type { Profile, ProxyType, SavedProxy } from '../../shared/types'

const genId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

function isPort(x?: string): boolean {
  if (!x) return false
  const n = Number(x)
  return Number.isInteger(n) && n > 0 && n <= 65535
}

/**
 * Parse one pasted proxy line. Handles, in any order:
 *   user:pass@host:port   ·   host:port@user:pass
 *   host:port:user:pass   ·   host:port   ·   scheme://…   ·   trailing :SOCKS5
 * defaultType applies when the line has no scheme/marker.
 */
function parseLine(line: string, defaultType: ProxyType): Omit<SavedProxy, 'id' | 'label'> | null {
  let s = line.trim()
  if (!s) return null
  let type: ProxyType = defaultType
  const scheme = s.match(/^(https?|socks5):\/\//i)
  if (scheme) {
    const k = scheme[1].toLowerCase()
    type = k === 'socks5' ? 'socks5' : k === 'https' ? 'https' : 'http'
    s = s.slice(scheme[0].length)
  }
  // trailing type marker: ...:SOCKS5 / :HTTP / :HTTPS
  const tail = s.match(/:(socks5|https?)$/i)
  if (tail) {
    const k = tail[1].toLowerCase()
    type = k === 'socks5' ? 'socks5' : k === 'https' ? 'https' : 'http'
    s = s.slice(0, s.length - tail[0].length)
  }

  let host = ''
  let port = 0
  let username: string | undefined
  let password: string | undefined

  if (s.includes('@')) {
    const at = s.split('@')
    if (at.length !== 2) return null
    const aP = at[0].split(':')
    const bP = at[1].split(':')
    const aHost = aP.length === 2 && isPort(aP[1])
    const bHost = bP.length === 2 && isPort(bP[1])
    let hp: string[]
    let cred: string[]
    if (bHost && !aHost) {
      hp = bP // user:pass@host:port
      cred = aP
    } else if (aHost && !bHost) {
      hp = aP // host:port@user:pass
      cred = bP
    } else if (aHost && bHost) {
      // both numeric: host side = the one whose first token looks like a host (has a dot)
      if (/\./.test(aP[0]) && !/\./.test(bP[0])) {
        hp = aP
        cred = bP
      } else {
        hp = bP
        cred = aP
      }
    } else {
      return null
    }
    host = hp[0]
    port = Number(hp[1])
    username = cred[0]
    password = cred[1]
  } else {
    const parts = s.split(':')
    if (parts.length === 2 && isPort(parts[1])) {
      host = parts[0]
      port = Number(parts[1])
    } else if (parts.length === 4 && isPort(parts[1])) {
      host = parts[0]
      port = Number(parts[1])
      username = parts[2]
      password = parts[3]
    } else {
      return null
    }
  }
  if (!host || !isPort(String(port))) return null
  return { type, host, port, username, password }
}

export function ProxyManagerModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [proxies, setProxies] = useState<SavedProxy[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [paste, setPaste] = useState('')
  const [importType, setImportType] = useState<ProxyType>('socks5')
  const [importName, setImportName] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = async (): Promise<void> => {
    setProxies(await window.vgc.listProxies())
    setProfiles(await window.vgc.listProfiles())
  }
  useEffect(() => {
    void refresh()
  }, [])

  const profileName = (id?: string): string =>
    id ? profiles.find((p) => p.id === id)?.name ?? '(đã xoá)' : ''

  const toggle = (id: string): void =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const tickAll = (): void => setChecked(new Set(proxies.map((p) => p.id)))
  const untick = (): void => setChecked(new Set())

  // Probe one proxy → return the updated record (does NOT save, to avoid racing
  // parallel writes; callers persist via saveProxy/saveManyProxies).
  const probe = async (p: SavedProxy): Promise<SavedProxy> => {
    setChecking((s) => new Set(s).add(p.id))
    try {
      const res = await window.vgc.checkProxy({
        type: p.type,
        host: p.host,
        port: p.port,
        username: p.username,
        password: p.password
      })
      return {
        ...p,
        lastStatus: res.ok ? 'ok' : 'error',
        lastIp: res.ip,
        lastCountry: res.country,
        lastCountryCode: res.countryCode,
        latencyMs: res.latencyMs
      }
    } finally {
      setChecking((s) => {
        const n = new Set(s)
        n.delete(p.id)
        return n
      })
    }
  }

  const checkOne = async (p: SavedProxy): Promise<void> => {
    await window.vgc.saveProxy(await probe(p))
    await refresh()
  }

  // Check many in parallel (cap 8 concurrent), save ALL at once at the end.
  const checkMany = async (list: SavedProxy[]): Promise<void> => {
    if (!list.length) return
    setMsg(`Đang check ${list.length} proxy…`)
    const CONC = 8
    const out: SavedProxy[] = []
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < list.length) {
        const idx = i++
        out.push(await probe(list[idx]))
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, () => worker()))
    await window.vgc.saveManyProxies(out)
    const ok = out.filter((p) => p.lastStatus === 'ok').length
    setMsg(`✓ Xong: ${ok} sống / ${out.length - ok} lỗi`)
    await refresh()
  }

  const assign = async (proxy: SavedProxy, profileId: string): Promise<void> => {
    // If this proxy was on a different profile, clear that profile's proxy first.
    if (proxy.assignedTo && proxy.assignedTo !== profileId) {
      await window.vgc.updateProfile(proxy.assignedTo, { proxy: { type: 'none' } })
    }
    if (profileId) {
      await window.vgc.updateProfile(profileId, {
        proxy: { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }
      })
      // ensure 1 proxy ↔ 1 profile: clear other proxies pointing at this profile
      for (const x of proxies) {
        if (x.id !== proxy.id && x.assignedTo === profileId) {
          await window.vgc.saveProxy({ ...x, assignedTo: '' })
        }
      }
    }
    await window.vgc.saveProxy({ ...proxy, assignedTo: profileId || '' })
    setMsg(profileId ? `✓ Đã gán "${proxy.label}" cho "${profileName(profileId)}"` : 'Đã bỏ gán.')
    await refresh()
  }

  const del = async (id: string): Promise<void> => {
    await window.vgc.deleteProxy(id)
    await refresh()
  }
  const rename = async (p: SavedProxy, label: string): Promise<void> => {
    const l = label.trim()
    if (!l || l === p.label) return
    await window.vgc.saveProxy({ ...p, label: l })
    await refresh()
  }
  const delSelected = async (): Promise<void> => {
    for (const id of checked) await window.vgc.deleteProxy(id)
    setChecked(new Set())
    await refresh()
  }
  const delErrors = async (): Promise<void> => {
    for (const p of proxies.filter((p) => p.lastStatus === 'error')) await window.vgc.deleteProxy(p.id)
    await refresh()
  }
  const dedupe = async (): Promise<void> => {
    const seen = new Set<string>()
    for (const p of proxies) {
      const key = `${p.type}://${p.host}:${p.port}:${p.username ?? ''}`
      if (seen.has(key)) await window.vgc.deleteProxy(p.id)
      else seen.add(key)
    }
    await refresh()
  }

  const importPaste = async (): Promise<void> => {
    const items: SavedProxy[] = paste
      .split('\n')
      .map((l) => parseLine(l, importType))
      .filter((x): x is Omit<SavedProxy, 'id' | 'label'> => !!x && !!x.host && !!x.port)
      .map((x, idx) => ({
        ...x,
        id: genId(),
        label: importName.trim() ? `${importName.trim()} ${idx + 1}` : `${x.host}:${x.port}`
      }))
    if (items.length) {
      await window.vgc.saveManyProxies(items)
      setPaste('')
      setMsg(`Đã thêm ${items.length} proxy vào pool.`)
      await refresh()
    } else {
      setMsg('Không đọc được dòng proxy nào.')
    }
  }

  const used = proxies.filter((p) => p.assignedTo).length

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 1000, maxWidth: '96vw' }}>
        <header className="modal-head">
          <h2>📡 Pool Proxy IP</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <h3>Dán / Import proxy</h3>
            <textarea
              rows={3}
              placeholder={'Mỗi dòng 1 proxy (nhiều định dạng đều nhận):\nhost:port@user:pass\nuser:pass@host:port\nhost:port:user:pass\nsocks5://user:pass@host:port'}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              style={{ width: '100%' }}
            />
            <div className="proxy-check" style={{ alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <input
                placeholder="Tên proxy (tuỳ chọn)"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                style={{
                  width: 200,
                  padding: '8px 10px',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  color: 'var(--text)',
                  outline: 'none'
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>Loại</span>
              <select
                className="group-select"
                value={importType}
                onChange={(e) => setImportType(e.target.value as ProxyType)}
              >
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>
              <button className="btn primary" onClick={importPaste}>
                ↧ Import vào pool
              </button>
            </div>
            <p className="hint">
              Đặt <b>Tên proxy</b> để các proxy import được đánh tên (Tên 1, Tên 2…) cho dễ quản lý — bỏ trống thì lấy
              host:port. Loại áp cho dòng không ghi scheme; dòng có <code>socks5://…</code>/<code>:SOCKS5</code> tự nhận đúng loại.
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>
                Pool ({proxies.length}) · đang dùng: {used} · trống: {proxies.length - used}
              </h3>
            </div>
            <div className="proxy-check" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <button className="btn primary" onClick={() => void checkMany(proxies)}>✓ Check tất cả</button>
              <button className="btn" onClick={() => void checkMany(proxies.filter((p) => checked.has(p.id)))}>✓ Check đã chọn</button>
              <button className="btn" onClick={delErrors}>🧹 Xoá proxy lỗi</button>
              <button className="btn" onClick={dedupe}>⎘ Xoá trùng lặp</button>
              <button className="btn danger" onClick={delSelected}>🗑 Xoá đã chọn</button>
              <button className="btn" onClick={tickAll}>Tích tất cả</button>
              <button className="btn ghost" onClick={untick}>Bỏ tích</button>
            </div>

            {proxies.length === 0 ? (
              <p className="hint">Pool trống. Tạo từ nhà cung cấp hoặc import ở trên.</p>
            ) : (
              <div style={{ overflow: 'auto' }}>
                <table className="profiles pool">
                  <colgroup>
                    <col style={{ width: 34 }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '6%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '19%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: 56 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="check-col"></th>
                      <th>Tên</th>
                      <th>Host</th>
                      <th>Port</th>
                      <th>User</th>
                      <th>Loại</th>
                      <th>Trạng thái</th>
                      <th>IP · Country · Latency</th>
                      <th>Gán cho profile</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {proxies.map((p) => (
                      <tr key={p.id}>
                        <td className="check-col">
                          <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} />
                        </td>
                        <td>
                          <input
                            key={p.id}
                            defaultValue={p.label}
                            title="Sửa tên proxy (rời ô để lưu)"
                            onBlur={(e) => void rename(p, e.target.value)}
                            style={{
                              width: '100%',
                              background: 'var(--panel-2)',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                              color: 'var(--text)',
                              padding: '5px 7px',
                              fontSize: 12,
                              outline: 'none'
                            }}
                          />
                        </td>
                        <td className="mono small">{p.host}</td>
                        <td className="mono small">{p.port}</td>
                        <td className="mono small">{p.username || '—'}</td>
                        <td className="mono small">{p.type}</td>
                        <td className="small">
                          {p.assignedTo ? (
                            <span style={{ color: 'var(--accent)' }}>● {profileName(p.assignedTo)}</span>
                          ) : (
                            <span className="dim">Trống</span>
                          )}
                        </td>
                        <td className="mono small">
                          {checking.has(p.id) ? (
                            'đang check…'
                          ) : p.lastStatus === 'ok' ? (
                            <span style={{ color: 'var(--green)' }}>
                              {p.lastIp} · {(p.lastCountryCode || '').toUpperCase()} {p.lastCountry} · {p.latencyMs}ms
                            </span>
                          ) : p.lastStatus === 'error' ? (
                            <span style={{ color: 'var(--red)' }}>✗ lỗi</span>
                          ) : (
                            <button className="btn" onClick={() => void checkOne(p)}>Kiểm tra</button>
                          )}
                        </td>
                        <td>
                          <select
                            className="group-select"
                            value={p.assignedTo ?? ''}
                            onChange={(e) => void assign(p, e.target.value)}
                          >
                            <option value="">— Trống (bỏ gán)</option>
                            {profiles.map((pr) => (
                              <option key={pr.id} value={pr.id}>
                                {pr.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button className="btn danger" onClick={() => void del(p.id)}>
                            Xoá
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {msg && (
              <p className="hint" style={{ color: msg.startsWith('Lỗi') ? 'var(--red)' : 'var(--green)' }}>
                {msg}
              </p>
            )}
          </section>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Đóng
          </button>
        </footer>
      </div>
    </div>
  )
}
