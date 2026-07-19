import { useEffect, useState } from 'react'
import type {
  AccountStatus,
  Cookie,
  Fingerprint,
  OsType,
  Profile,
  ProxyCheckResult,
  ProxyType,
  SavedProxy
} from '../../shared/types'

const genId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

interface Props {
  profile: Profile
  onClose: () => void
  onSaved: () => void
}

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Singapore',
  'Asia/Ho_Chi_Minh',
  'Asia/Tokyo'
]

const SCREENS = ['1920x1080', '1366x768', '2560x1440', '1536x864', '1440x900']

const GPUS = [
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  }
]

const OS_OPTIONS: OsType[] = ['windows', 'macos', 'linux', 'android']
const PROXY_TYPES: ProxyType[] = ['none', 'http', 'https', 'socks5']
const CORES = [2, 4, 6, 8, 12, 16]
const MEMORY = [2, 4, 8, 16]

export function EditProfileModal({ profile, onClose, onSaved }: Props): JSX.Element {
  const [name, setName] = useState(profile.name)
  const [group, setGroup] = useState(profile.group ?? '')
  const [tags, setTags] = useState(profile.tags.join(', '))
  const [notes, setNotes] = useState(profile.notes)
  const [accUser, setAccUser] = useState(profile.account?.user ?? '')
  const [accPass, setAccPass] = useState(profile.account?.pass ?? '')
  const [accTotp, setAccTotp] = useState(profile.account?.totp ?? '')
  const [accStatus, setAccStatus] = useState<AccountStatus | ''>(profile.account?.status ?? '')
  const [startUrls, setStartUrls] = useState(profile.startUrls.join('\n'))
  const [os, setOs] = useState<OsType>(profile.os)
  const [proxy, setProxy] = useState({ ...profile.proxy })
  const [fp, setFp] = useState<Fingerprint>({ ...profile.fingerprint })
  const [cookies, setCookies] = useState<Cookie[]>(profile.cookies ?? [])
  const [extensions, setExtensions] = useState<string[]>(profile.extensions ?? [])
  const [newCookie, setNewCookie] = useState({ name: '', value: '', domain: '' })
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [proxyResult, setProxyResult] = useState<ProxyCheckResult | null>(null)
  const [savedProxies, setSavedProxies] = useState<SavedProxy[]>([])
  const [allProfiles, setAllProfiles] = useState<Profile[]>([])

  useEffect(() => {
    void window.vgc.listProxies().then(setSavedProxies)
    void window.vgc.listProfiles().then(setAllProfiles)
  }, [])

  const proxyStatus = (sp: SavedProxy): string => {
    if (!sp.assignedTo) return 'Trống'
    if (sp.assignedTo === profile.id) return 'đang gán cho profile này'
    const n = allProfiles.find((p) => p.id === sp.assignedTo)?.name
    return n ? `đang dùng: ${n}` : 'đang dùng'
  }

  const useSavedProxy = (id: string): void => {
    const sp = savedProxies.find((p) => p.id === id)
    if (sp) {
      setProxy({
        type: sp.type,
        host: sp.host,
        port: sp.port,
        username: sp.username,
        password: sp.password
      })
      setProxyResult(null)
    }
  }

  const saveProxyToManager = async (): Promise<void> => {
    if (proxy.type === 'none' || !proxy.host || !proxy.port) return
    await window.vgc.saveProxy({
      id: genId(),
      label: `${proxy.host}:${proxy.port}`,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password
    })
    setSavedProxies(await window.vgc.listProxies())
    window.alert('Đã lưu proxy vào Proxy Manager.')
  }

  const runCookieRobot = async (): Promise<void> => {
    await window.vgc.cookieRobot(profile.id)
    window.alert('Cookie robot đang ghé các site làm ấm profile…')
  }

  const patchFp = (p: Partial<Fingerprint>): void => setFp((cur) => ({ ...cur, ...p }))

  const regenerate = async (): Promise<void> => {
    const fresh = await window.vgc.generateFingerprint(os)
    setFp(fresh)
  }

  // Changing OS must re-roll the OS-bound fingerprint (UA, platform, WebGL/GPU,
  // fonts, screen) so a "macOS" profile never keeps a Windows GPU/UA — that mismatch
  // is a dead giveaway. (Timezone/geo get re-aligned to the proxy again at launch.)
  const changeOs = async (next: OsType): Promise<void> => {
    setOs(next)
    setFp(await window.vgc.generateFingerprint(next))
  }

  const checkProxyNow = async (): Promise<void> => {
    setChecking(true)
    setProxyResult(null)
    try {
      setProxyResult(await window.vgc.checkProxy(proxy))
    } finally {
      setChecking(false)
    }
  }

  const applyProxyGeo = (): void => {
    if (!proxyResult?.ok) return
    patchFp({
      timezone: proxyResult.timezone || fp.timezone,
      webrtcPublicIp: proxyResult.ip || fp.webrtcPublicIp,
      geolocation:
        proxyResult.latitude != null && proxyResult.longitude != null
          ? { latitude: proxyResult.latitude, longitude: proxyResult.longitude, accuracy: 100 }
          : fp.geolocation
    })
  }

  const importCookiesNow = async (): Promise<void> => {
    const c = await window.vgc.importCookies()
    if (c.length) setCookies(c)
  }

  const updateCookieValue = (idx: number, value: string): void =>
    setCookies((prev) => prev.map((c, i) => (i === idx ? { ...c, value } : c)))

  const deleteCookie = (idx: number): void =>
    setCookies((prev) => prev.filter((_, i) => i !== idx))

  const addCookie = (): void => {
    if (!newCookie.name || !newCookie.domain) return
    setCookies((prev) => [
      ...prev,
      { name: newCookie.name, value: newCookie.value, domain: newCookie.domain, path: '/' }
    ])
    setNewCookie({ name: '', value: '', domain: '' })
  }

  const exportCookiesNow = async (): Promise<void> => {
    const r = await window.vgc.exportCookies(profile.id)
    if (r.error) window.alert(r.error)
    else if (r.count) window.alert(`Đã xuất ${r.count} cookie.`)
  }

  const addExtension = async (): Promise<void> => {
    const folder = await window.vgc.pickFolder()
    if (folder) setExtensions((prev) => (prev.includes(folder) ? prev : [...prev, folder]))
  }

  const removeExtension = (idx: number): void => {
    setExtensions((prev) => prev.filter((_, i) => i !== idx))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      // Merge account: re-read the freshest persisted account and overwrite ONLY the fields the
      // user actually changed here — so a background cloud-pull update to a field the user didn't
      // touch (e.g. status set on another machine) isn't reverted by this save.
      const latest = (await window.vgc.listProfiles()).find((x) => x.id === profile.id)
      const acct: NonNullable<Profile['account']> = { ...(latest?.account ?? profile.account ?? {}) }
      if (accUser.trim() !== (profile.account?.user ?? '')) acct.user = accUser.trim() || undefined
      if (accPass !== (profile.account?.pass ?? '')) acct.pass = accPass || undefined
      if (accTotp.trim() !== (profile.account?.totp ?? '')) acct.totp = accTotp.trim() || undefined
      if (accStatus !== (profile.account?.status ?? '')) acct.status = accStatus || undefined
      await window.vgc.updateProfile(profile.id, {
        name: name.trim() || profile.name,
        group: group.trim() || undefined,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes,
        startUrls: startUrls
          .split('\n')
          .map((u) => u.trim())
          .filter(Boolean),
        os,
        proxy,
        cookies,
        extensions,
        fingerprint: fp,
        account: acct
      })
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const screenValue = `${fp.screen.width}x${fp.screen.height}`

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Sửa profile</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <h3>Thông tin</h3>
            <label>
              Tên
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="row2">
              <label>
                Nhóm
                <input value={group} onChange={(e) => setGroup(e.target.value)} />
              </label>
              <label>
                OS
                <select value={os} onChange={(e) => void changeOs(e.target.value as OsType)}>
                  {OS_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Tags (phân cách bằng dấu phẩy)
              <input value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
            <label>
              Ghi chú
              <textarea value={notes} rows={2} onChange={(e) => setNotes(e.target.value)} />
            </label>

            <div className="field-title" style={{ marginTop: 6, fontWeight: 600, color: 'var(--accent, #4fd1a1)' }}>
              👤 Tài khoản
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label>
                Email / user
                <input value={accUser} onChange={(e) => setAccUser(e.target.value)} />
              </label>
              <label>
                Mật khẩu
                <input value={accPass} onChange={(e) => setAccPass(e.target.value)} />
              </label>
              <label>
                Khóa 2FA (base32)
                <input
                  value={accTotp}
                  onChange={(e) => setAccTotp(e.target.value)}
                  placeholder="JBSWY3DPEHPK3PXP"
                />
              </label>
              <label>
                Trạng thái
                <select
                  value={accStatus}
                  onChange={(e) => setAccStatus(e.target.value as AccountStatus | '')}
                >
                  <option value="">— chưa đặt —</option>
                  <option value="live">Live</option>
                  <option value="ready">Sẵn sàng</option>
                  <option value="die">Die</option>
                  <option value="banned">Banned</option>
                </select>
              </label>
            </div>

            <label>
              Trang khởi động (mỗi dòng 1 URL)
              <textarea
                value={startUrls}
                rows={2}
                placeholder="https://..."
                onChange={(e) => setStartUrls(e.target.value)}
              />
            </label>
          </section>

          <section className="card">
            <h3>Proxy</h3>
            {savedProxies.length > 0 && (
              <label>
                Dùng proxy đã lưu
                <select defaultValue="" onChange={(e) => useSavedProxy(e.target.value)}>
                  <option value="">— Chọn từ Proxy Manager —</option>
                  {[...savedProxies]
                    .sort((a, b) => (a.assignedTo ? 1 : 0) - (b.assignedTo ? 1 : 0))
                    .map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.assignedTo ? '🔒' : '🟢'} {sp.label} ({sp.type}) — {proxyStatus(sp)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <div className="row2">
              <label>
                Loại
                <select
                  value={proxy.type}
                  onChange={(e) => setProxy({ ...proxy, type: e.target.value as ProxyType })}
                >
                  {PROXY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Host
                <input
                  value={proxy.host ?? ''}
                  disabled={proxy.type === 'none'}
                  onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                />
              </label>
            </div>
            <div className="row2">
              <label>
                Port
                <input
                  type="number"
                  value={proxy.port ?? ''}
                  disabled={proxy.type === 'none'}
                  onChange={(e) => setProxy({ ...proxy, port: Number(e.target.value) || undefined })}
                />
              </label>
              <label>
                Username
                <input
                  value={proxy.username ?? ''}
                  disabled={proxy.type === 'none'}
                  onChange={(e) => setProxy({ ...proxy, username: e.target.value })}
                />
              </label>
            </div>
            <label>
              Password
              <input
                type="password"
                value={proxy.password ?? ''}
                disabled={proxy.type === 'none'}
                onChange={(e) => setProxy({ ...proxy, password: e.target.value })}
              />
            </label>
            <div className="proxy-check">
              <button
                className="btn"
                onClick={checkProxyNow}
                disabled={checking || proxy.type === 'none'}
              >
                {checking ? 'Đang kiểm tra…' : 'Kiểm tra proxy'}
              </button>
              {proxyResult &&
                (proxyResult.ok ? (
                  <span className="ok">
                    ✓ {proxyResult.ip} · {proxyResult.country}
                    {proxyResult.city ? ` · ${proxyResult.city}` : ''} · {proxyResult.timezone}
                  </span>
                ) : (
                  <span className="err">✗ {proxyResult.error}</span>
                ))}
              {proxyResult?.ok && (
                <button className="btn" onClick={applyProxyGeo}>
                  Áp timezone/geo
                </button>
              )}
              <button className="btn" onClick={saveProxyToManager} disabled={proxy.type === 'none'}>
                💾 Lưu proxy
              </button>
            </div>
            <p className="hint">Proxy có mật khẩu sẽ tự chạy qua relay nội bộ khi mở.</p>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Cookies</h3>
              <div>
                <button className="btn" onClick={importCookiesNow}>
                  ↧ Nhập (JSON)
                </button>
                <button className="btn" style={{ marginLeft: 6 }} onClick={exportCookiesNow}>
                  ↥ Xuất
                </button>
                <button className="btn" style={{ marginLeft: 6 }} onClick={runCookieRobot}>
                  🤖 Cookie robot
                </button>
              </div>
            </div>
            <p className="hint">
              {cookies.length} cookie — nạp vào profile trước khi mở trang. (Xuất yêu cầu
              profile đang chạy.)
            </p>
            {cookies.length > 0 && (
              <ul className="ext-list" style={{ maxHeight: 160, overflow: 'auto' }}>
                {cookies.map((c, i) => (
                  <li key={`${c.domain}-${c.name}-${i}`}>
                    <span className="mono small" style={{ flex: '0 0 36%' }}>
                      {c.name} · {c.domain}
                    </span>
                    <input
                      className="mono small"
                      style={{ flex: 1, marginRight: 6 }}
                      value={c.value}
                      onChange={(e) => updateCookieValue(i, e.target.value)}
                    />
                    <button className="btn ghost" onClick={() => deleteCookie(i)}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="token-row">
              <input
                placeholder="name"
                value={newCookie.name}
                onChange={(e) => setNewCookie({ ...newCookie, name: e.target.value })}
              />
              <input
                placeholder="value"
                value={newCookie.value}
                onChange={(e) => setNewCookie({ ...newCookie, value: e.target.value })}
              />
              <input
                placeholder="domain (.vd.com)"
                value={newCookie.domain}
                onChange={(e) => setNewCookie({ ...newCookie, domain: e.target.value })}
              />
              <button className="btn" onClick={addCookie}>
                + Thêm
              </button>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Extensions</h3>
              <button className="btn" onClick={addExtension}>
                + Thêm thư mục
              </button>
            </div>
            {extensions.length === 0 ? (
              <p className="hint">Chưa có extension. Chọn thư mục extension đã giải nén.</p>
            ) : (
              <ul className="ext-list">
                {extensions.map((e, i) => (
                  <li key={e}>
                    <span className="mono small">{e}</span>
                    <button className="btn ghost" onClick={() => removeExtension(i)}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Fingerprint</h3>
              <button className="btn" onClick={regenerate}>
                ⟳ Tạo fingerprint mới
              </button>
            </div>
            <div className="row2">
              <label>
                Timezone
                <select value={fp.timezone} onChange={(e) => patchFp({ timezone: e.target.value })}>
                  {[fp.timezone, ...TIMEZONES.filter((t) => t !== fp.timezone)].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ngôn ngữ
                <input
                  value={fp.language}
                  onChange={(e) => patchFp({ language: e.target.value, languages: [e.target.value, 'en'] })}
                />
              </label>
            </div>
            <div className="row2">
              <label>
                Màn hình
                <select
                  value={screenValue}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split('x').map(Number)
                    patchFp({ screen: { ...fp.screen, width: w, height: h } })
                  }}
                >
                  {[screenValue, ...SCREENS.filter((s) => s !== screenValue)].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                CPU cores
                <select
                  value={fp.hardwareConcurrency}
                  onChange={(e) => patchFp({ hardwareConcurrency: Number(e.target.value) })}
                >
                  {CORES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row2">
              <label>
                RAM (GB)
                <select
                  value={fp.deviceMemory}
                  onChange={(e) => patchFp({ deviceMemory: Number(e.target.value) })}
                >
                  {MEMORY.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                GPU (WebGL)
                <select
                  value={fp.webgl.renderer}
                  onChange={(e) => {
                    const gpu = GPUS.find((g) => g.renderer === e.target.value)
                    if (gpu) patchFp({ webgl: { ...gpu } })
                  }}
                >
                  {[fp.webgl, ...GPUS.filter((g) => g.renderer !== fp.webgl.renderer)].map((g) => (
                    <option key={g.renderer} value={g.renderer}>
                      {g.renderer.replace(/^ANGLE \([^,]+, /, '').replace(/ Direct3D.*$/, '')}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="checks">
              <span>
                <input
                  type="checkbox"
                  checked={fp.canvasNoise}
                  onChange={(e) => patchFp({ canvasNoise: e.target.checked })}
                />{' '}
                Canvas noise
              </span>
              <span>
                <input
                  type="checkbox"
                  checked={fp.audioNoise}
                  onChange={(e) => patchFp({ audioNoise: e.target.checked })}
                />{' '}
                Audio noise
              </span>
              <span>
                WebRTC:{' '}
                <select
                  value={fp.webrtc}
                  onChange={(e) => patchFp({ webrtc: e.target.value as Fingerprint['webrtc'] })}
                >
                  <option value="proxy">proxy</option>
                  <option value="disabled">disabled</option>
                  <option value="real">real</option>
                </select>
              </span>
            </label>
            <label>
              User-Agent
              <input className="mono small" value={fp.userAgent} readOnly />
            </label>
          </section>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </footer>
      </div>
    </div>
  )
}
