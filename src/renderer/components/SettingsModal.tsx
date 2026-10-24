import { useEffect, useState, type CSSProperties } from 'react'
import type { UpdateStatus } from '../../shared/types'
import { Icon } from './Icon'

const inp: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  color: 'var(--text)',
  outline: 'none'
}

interface Props {
  onClose: () => void
  theme: 'dark' | 'light'
  onSetTheme: (t: 'dark' | 'light') => void
  accountEmail?: string
  onSignOut: () => void
  onOpenCloud: () => void
  /** Đã nhập đúng mật khẩu bảo mật trong phiên này → hiện phần Khoá bảo vệ. */
  guardAdmin: boolean
  onSetGuardAdmin: (v: boolean) => void
}

function updateLabel(s: UpdateStatus | null): string {
  if (!s) return ''
  switch (s.phase) {
    case 'checking':
      return 'Đang kiểm tra cập nhật…'
    case 'available':
      return s.manualDownloadUrl
        ? `Có bản mới ${s.newVersion ? `v${s.newVersion}` : ''} — bấm "Tải về" để cập nhật.`
        : `Có bản mới ${s.newVersion ? `v${s.newVersion}` : ''} — đang tải…`
    case 'downloading':
      return `Đang tải bản mới… ${s.percent ?? 0}%`
    case 'downloaded':
      return `Đã tải xong ${s.newVersion ? `v${s.newVersion}` : 'bản mới'} — bấm "Khởi động lại để cập nhật".`
    case 'up-to-date':
      return 'Bạn đang dùng phiên bản mới nhất.'
    case 'error':
      return `Lỗi kiểm tra cập nhật: ${s.message ?? ''}`
    case 'dev':
      return `${s.message ?? 'Chỉ chạy ở bản đã cài đặt.'}`
    default:
      return ''
  }
}

export function SettingsModal({
  onClose,
  theme,
  onSetTheme,
  accountEmail,
  onSignOut,
  onOpenCloud,
  guardAdmin,
  onSetGuardAdmin
}: Props): JSX.Element {
  const [version, setVersion] = useState<string>('')
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [apiEnabled, setApiEnabled] = useState(false)
  const [apiPort, setApiPort] = useState('36912')
  const [apiToken, setApiToken] = useState('')
  const [apiTokenVisible, setApiTokenVisible] = useState(false)
  const [apiMsg, setApiMsg] = useState('')
  // iProyal proxy provider credentials (used by Proxy → "Tạo proxy qua API").
  const [ipToken, setIpToken] = useState('')
  const [ipUser, setIpUser] = useState('')
  const [ipPass, setIpPass] = useState('')
  const [ipMsg, setIpMsg] = useState('')
  // Evomi proxy provider — a single API key is enough.
  const [evoKey, setEvoKey] = useState('')
  const [evoMsg, setEvoMsg] = useState('')
  // Cliproxy proxy provider — gateway host/port + account username/password (dashboard).
  const [cpHost, setCpHost] = useState('us.cliproxy.io')
  const [cpPort, setCpPort] = useState('')
  const [cpUser, setCpUser] = useState('')
  const [cpPass, setCpPass] = useState('')
  const [cpState, setCpState] = useState('')
  const [cpMsg, setCpMsg] = useState('')

  const [capKey, setCapKey] = useState('')
  const [capMsg, setCapMsg] = useState('')
  const [cloudPassphrase, setCloudPassphrase] = useState('')
  const [cloudEncryptionConfigured, setCloudEncryptionConfigured] = useState(false)
  const [cloudEncryptionMsg, setCloudEncryptionMsg] = useState('')

  // Khoá bảo vệ profile (tự huỷ khi nhập sai)
  const [gHasMaster, setGHasMaster] = useState(false)
  const [gHasSos, setGHasSos] = useState(false)
  const [gPerLimit, setGPerLimit] = useState(3)
  const [gGlobalLimit, setGGlobalLimit] = useState(5)
  const [gLockedCount, setGLockedCount] = useState(0)
  const [gRelock, setGRelock] = useState(5)
  // Sao lưu / khôi phục TẤT CẢ passkey ra file .vgcpk
  const [pkAllPass, setPkAllPass] = useState('')
  const [pkAllMsg, setPkAllMsg] = useState('')
  const syncPasskeysNow = async (): Promise<void> => {
    setPkAllMsg('Đang quét két passkey…')
    const r = await window.vgc.passkeySyncNow()
    setPkAllMsg(
      r.ok
        ? `Đã đồng bộ ✓ — két có ${r.total ?? 0} passkey` +
            (r.pulled ? `, kéo về ${r.pulled} passkey mới` : '') +
            (r.pushed ? ', đã cập nhật lên cloud' : '')
        : r.error || 'Không đồng bộ được.'
    )
  }
  const backupAllPasskeys = async (): Promise<void> => {
    setPkAllMsg('')
    const r = await window.vgc.passkeyExport(null, pkAllPass)
    if (r.canceled) return
    setPkAllMsg(r.ok ? `Đã sao lưu ${r.creds} passkey của ${r.profiles} profile ✓` : r.error || 'Không sao lưu được.')
  }
  const restoreAllPasskeys = async (): Promise<void> => {
    setPkAllMsg('')
    const r = await window.vgc.passkeyImport(pkAllPass)
    if (r.canceled) return
    setPkAllMsg(
      r.ok
        ? `Đã khôi phục ${r.creds} passkey cho ${r.profiles} profile ✓${r.skipped ? ` (bỏ qua ${r.skipped} passkey của profile không còn)` : ''}`
        : r.error || 'Không khôi phục được.'
    )
  }
  const [gMasterNew, setGMasterNew] = useState('')
  const [gSosNew, setGSosNew] = useState('')
  const [gAuth, setGAuth] = useState('')
  const [gMsg, setGMsg] = useState('')
  const [revealPw, setRevealPw] = useState('')
  const [revealMsg, setRevealMsg] = useState('')
  const [groupNames, setGroupNames] = useState<string[]>([])
  const [lockedGroupSet, setLockedGroupSet] = useState<Set<string>>(new Set())
  const [gSelGroup, setGSelGroup] = useState('')
  const [gGroupCode, setGGroupCode] = useState('')
  const [groupMsg, setGroupMsg] = useState('')

  const loadGroups = async (): Promise<void> => {
    try {
      const profs = await window.vgc.listProfiles()
      const names = Array.from(new Set(profs.map((p) => p.group).filter((g): g is string => !!g))).sort()
      setGroupNames(names)
      setLockedGroupSet(new Set(await window.vgc.guardLockedGroups()))
    } catch { /* ignore */ }
  }
  const saveGroupLock = async (remove: boolean): Promise<void> => {
    setGroupMsg('')
    const name = gSelGroup
    if (!name) { setGroupMsg('Chọn nhóm trước.'); return }
    if (!remove && gGroupCode.length < 1) { setGroupMsg('Nhập mã khoá cho nhóm.'); return }
    const res = await window.vgc.guardSetGroupLock(name, remove ? '' : gGroupCode, gPerLimit)
    if (!res.ok) { setGroupMsg(res.error || 'Không lưu được.'); return }
    setGGroupCode('')
    setGroupMsg(remove ? `Đã gỡ khoá nhóm "${name}".` : `Đã khoá nhóm "${name}" ✓`)
    await loadGroups()
  }

  const revealGuard = async (): Promise<void> => {
    setRevealMsg('')
    const ok = await window.vgc.guardCheckAdmin(revealPw)
    if (ok) {
      onSetGuardAdmin(true)
      setRevealPw('')
      await loadGuard()
      await loadGroups()
    } else {
      setRevealMsg('Sai mật khẩu bảo mật.')
      setRevealPw('')
    }
  }

  const loadGuard = async (): Promise<void> => {
    const s = await window.vgc.guardStatus()
    setGHasMaster(s.hasMaster)
    setGHasSos(s.hasSos)
    setGPerLimit(s.perProfileLimit)
    setGGlobalLimit(s.globalLimit)
    setGLockedCount(s.lockedCount)
    setGRelock(s.relockMinutes)
  }
  const saveMaster = async (remove: boolean): Promise<void> => {
    setGMsg('')
    const res = await window.vgc.guardSetMaster(remove ? '' : gMasterNew, gHasMaster ? gAuth : undefined)
    if (!res.ok) { setGMsg(res.error || 'Không lưu được.'); return }
    setGMasterNew(''); setGAuth(''); setGMsg(remove ? 'Đã gỡ mật khẩu chủ.' : 'Đã lưu mật khẩu chủ ✓')
    await loadGuard()
  }
  const saveSos = async (remove: boolean): Promise<void> => {
    setGMsg('')
    const res = await window.vgc.guardSetSos(remove ? '' : gSosNew, gHasMaster ? gAuth : undefined)
    if (!res.ok) { setGMsg(res.error || 'Không lưu được.'); return }
    setGSosNew(''); setGAuth(''); setGMsg(remove ? 'Đã gỡ mật khẩu SOS.' : 'Đã lưu mật khẩu SOS ✓')
    await loadGuard()
  }
  const saveGuardLimits = async (): Promise<void> => {
    setGMsg('')
    const res = await window.vgc.guardSetLimits(gPerLimit, gGlobalLimit, gHasMaster ? gAuth : undefined)
    if (!res.ok) { setGMsg(res.error || 'Không lưu được.'); return }
    const rl = await window.vgc.guardSetRelock(gRelock)
    if (!rl.ok) { setGMsg(rl.error || 'Không lưu được thời gian tự khoá.'); return }
    setGAuth(''); setGMsg('Đã lưu giới hạn ✓')
    await loadGuard()
  }

  const saveIproyal = async (): Promise<void> => {
    await window.vgc.saveProviderCreds({
      iproyal: { username: ipUser.trim(), password: ipPass.trim(), apiToken: ipToken.trim() }
    })
    setIpMsg('Đã lưu tài khoản iProyal.')
  }

  const saveEvomi = async (): Promise<void> => {
    await window.vgc.saveProviderCreds({ evomi: { apiKey: evoKey.trim() } })
    setEvoMsg('Đã lưu API key Evomi.')
  }

  const saveCapsolver = async (): Promise<void> => {
    await window.vgc.saveSettings({ capsolverApiKey: capKey.trim() })
    setCapMsg(capKey.trim() ? 'Đã lưu API key CapSolver.' : 'Đã xoá API key CapSolver.')
  }

  const saveCloudPassphrase = async (): Promise<void> => {
    try {
      await window.vgc.cloudSetPassphrase(cloudPassphrase)
      setCloudPassphrase('')
      setCloudEncryptionConfigured(true)
      setCloudEncryptionMsg('Khoá cloud đã được bọc an toàn trên thiết bị này.')
    } catch (error) {
      setCloudEncryptionMsg(`${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveCliproxy = async (): Promise<void> => {
    const port = parseInt(cpPort.trim(), 10)
    if (!cpUser.trim() || !cpPass.trim() || !port) {
      setCpMsg('Cần nhập host, port, username, password (xem ở dash.cliproxy.com).')
      return
    }
    await window.vgc.saveProviderCreds({
      cliproxy: {
        host: cpHost.trim() || 'us.cliproxy.io',
        port,
        username: cpUser.trim(),
        password: cpPass.trim(),
        state: cpState.trim() || undefined
      }
    })
    setCpMsg('Đã lưu tài khoản Cliproxy.')
  }

  const saveApi = async (): Promise<void> => {
    const port = Number(apiPort)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setApiMsg('Port phải nằm trong khoảng 1024–65535.')
      return
    }
    try {
      const saved = await window.vgc.saveSettings({ apiEnabled, apiPort: port })
      setApiEnabled(saved.apiEnabled)
      setApiPort(String(saved.apiPort))
      setApiMsg(saved.apiEnabled ? 'API cục bộ đã bật.' : 'API cục bộ đã tắt.')
    } catch (error) {
      setApiMsg(`${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const regenerateApiToken = async (): Promise<void> => {
    try {
      const saved = await window.vgc.regenerateApiToken()
      setApiToken(saved.apiToken)
      setApiMsg('Đã tạo token mới; token cũ không còn hiệu lực.')
    } catch (error) {
      setApiMsg(`${error instanceof Error ? error.message : String(error)}`)
    }
  }

  useEffect(() => {
    void window.vgc.getProviderCreds().then((c) => {
      if (c.iproyal) {
        setIpUser(c.iproyal.username || '')
        setIpPass(c.iproyal.password || '')
        setIpToken(c.iproyal.apiToken || '')
      }
      if (c.evomi) setEvoKey(c.evomi.apiKey || '')
      if (c.cliproxy) {
        setCpHost(c.cliproxy.host || 'us.cliproxy.io')
        setCpPort(c.cliproxy.port ? String(c.cliproxy.port) : '')
        setCpUser(c.cliproxy.username || '')
        setCpPass(c.cliproxy.password || '')
        setCpState(c.cliproxy.state || '')
      }
    })
    void window.vgc.getVersion().then(setVersion)
    void loadGuard().catch(() => {})
    void window.vgc.cloudEncryptionStatus().then((status) => {
      setCloudEncryptionConfigured(status.configured && status.unlocked)
    })
    // The engine always runs in Native (VGC Core) mode — the antidetect-correct
    // config that also keeps Google login working — so the manual toggles were
    // removed. Normalise any stale saved value so no profile is stuck in CDP /
    // system-Chrome mode.
    void window.vgc.getSettings().then((s) => {
      if (s.nativeMode === false || s.useSystemBrowser) {
        void window.vgc.saveSettings({ nativeMode: true, useSystemBrowser: false })
      }
      setCapKey(s.capsolverApiKey || '')
      setApiEnabled(s.apiEnabled)
      setApiPort(String(s.apiPort))
      setApiToken(s.apiToken)
    })
    void window.vgc.getUpdateStatus().then((s) => {
      if (s.phase !== 'idle') setUpdate(s)
    })
    return window.vgc.onUpdateStatus(setUpdate)
  }, [])

  const checking = update?.phase === 'checking' || update?.phase === 'downloading'
  const downloaded = update?.phase === 'downloaded'
  // macOS: an unsigned build can't auto-install, so offer a manual download instead.
  const manual = update?.phase === 'available' && !!update?.manualDownloadUrl

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <header className="modal-head">
          <h2>Cài đặt</h2>
          <button className="btn" onClick={onClose}>
            <Icon name="x" size={16} strokeWidth={2.4} />
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <h3>Tài khoản</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              {accountEmail || 'Đang đăng nhập…'}
            </p>
            <div className="proxy-check">
              <button className="btn" onClick={onOpenCloud}>
                Cloud
              </button>
              <button className="btn" onClick={onSignOut}>
                Đổi tài khoản
              </button>
              <button className="btn danger" onClick={onSignOut}>
                Đăng xuất
              </button>
            </div>
          </section>

          <section className="card">
            <h3>API automation cục bộ</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={apiEnabled}
                  onChange={(e) => setApiEnabled(e.target.checked)}
                />
                Bật API trên 127.0.0.1
              </label>
              <input
                type="number"
                min={1024}
                max={65535}
                value={apiPort}
                onChange={(e) => setApiPort(e.target.value)}
                style={inp}
                aria-label="API port"
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                <input
                  readOnly
                  type={apiTokenVisible ? 'text' : 'password'}
                  value={apiToken}
                  style={inp}
                  aria-label="API bearer token"
                />
                <button className="btn" onClick={() => setApiTokenVisible((visible) => !visible)}>
                  {apiTokenVisible ? 'Ẩn' : 'Hiện'}
                </button>
              </div>
              <div className="proxy-check">
                <button className="btn primary" onClick={() => void saveApi()}>
                  Lưu API
                </button>
                <button className="btn" onClick={() => void regenerateApiToken()}>
                  Tạo token mới
                </button>
              </div>
              {apiMsg && <p className="hint">{apiMsg}</p>}
            </div>
          </section>

          <section className="card">
            <h3>Mã hoá cloud</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <input
                placeholder={
                  cloudEncryptionConfigured
                    ? 'Nhập lại passphrase cloud để xác minh'
                    : 'Passphrase cloud, tối thiểu 12 ký tự'
                }
                type="password"
                autoComplete={cloudEncryptionConfigured ? 'current-password' : 'new-password'}
                value={cloudPassphrase}
                onChange={(e) => setCloudPassphrase(e.target.value)}
                style={inp}
              />
              <div className="proxy-check" style={{ alignItems: 'center', gap: 10 }}>
                <button
                  className="btn primary"
                  disabled={cloudPassphrase.length < 12}
                  onClick={() => void saveCloudPassphrase()}
                >
                  Lưu passphrase
                </button>
                <span style={{ color: cloudEncryptionConfigured ? 'var(--green)' : 'var(--muted)', fontSize: 12 }}>
                  {cloudEncryptionMsg ||
                    (cloudEncryptionConfigured ? 'Đã mở khoá' : 'Chưa cấu hình')}
                </span>
              </div>
            </div>
          </section>

          {!guardAdmin ? (
            // ẨN mặc định: chỉ một ô nhỏ, gõ đúng mật khẩu bảo mật mới hiện phần khoá bảo vệ.
            <section className="card">
              <div className="row-inline" style={{ gap: 8, alignItems: 'center' }}>
                <span style={{ opacity: 0.6 }}>🔒</span>
                <input
                  type="password"
                  style={{ ...inp, maxWidth: 220 }}
                  value={revealPw}
                  placeholder="Mật khẩu bảo mật"
                  autoComplete="off"
                  onChange={(e) => setRevealPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void revealGuard() }}
                />
                <button className="btn" disabled={!revealPw} onClick={() => void revealGuard()}>Mở</button>
                {revealMsg && <span className="hint" style={{ margin: 0, color: '#e0534f' }}>{revealMsg}</span>}
              </div>
            </section>
          ) : (
            <section className="card">
              <div className="row-inline" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>🔒 Khoá bảo vệ profile (tự huỷ)</h3>
                <button className="btn" onClick={() => { onSetGuardAdmin(false); setGMsg('') }}>Ẩn lại</button>
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                Vào <b>Sửa profile</b> → mục này để bật khoá cho <b>từng profile</b> (không bật thì profile mở
                bình thường). Sai <b>{gPerLimit}</b> lần → xoá vĩnh viễn riêng profile đó; tổng sai <b>{gGlobalLimit}</b> lần
                (mọi profile) → xoá <b>TẤT CẢ</b>. Dữ liệu xoá gồm cả bản trên cloud, <b>không khôi phục được</b>.
                {gLockedCount > 0 && <> Hiện có <b>{gLockedCount}</b> profile đang khoá.</>}
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <label>
                  Sai mấy lần thì xoá 1 profile
                  <input type="number" min={1} max={99} value={gPerLimit} style={inp}
                    onChange={(e) => setGPerLimit(Math.max(1, Math.min(99, Number(e.target.value) || 3)))} />
                </label>
                <label>
                  Tổng sai mấy lần thì xoá TẤT CẢ
                  <input type="number" min={1} max={999} value={gGlobalLimit} style={inp}
                    onChange={(e) => setGGlobalLimit(Math.max(1, Math.min(999, Number(e.target.value) || 5)))} />
                </label>
              </div>

              <label style={{ display: 'block', marginBottom: 8 }}>
                Tự khoá cửa sổ trình duyệt sau (phút không thao tác, 0 = tắt)
                <input type="number" min={0} max={1440} value={gRelock} style={inp}
                  onChange={(e) => setGRelock(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))} />
                <span className="hint" style={{ display: 'block', margin: '2px 0 0' }}>
                  Profile khoá đang mở: hết thời gian này thì mọi cửa sổ của nó bị thu nhỏ và phải nhập
                  mật khẩu chủ mới dùng lại được. Áp dụng cho profile mở từ lần sau.
                </span>
              </label>
              <label style={{ display: 'block', marginBottom: 6 }}>
                Mật khẩu chủ {gHasMaster ? '(đã đặt — cũng là mật khẩu bảo mật để mở phần này)' : '(chưa đặt)'}
                <input type="password" style={inp} value={gMasterNew} placeholder={gHasMaster ? 'Nhập để ĐỔI' : 'Đặt mật khẩu chủ'}
                  autoComplete="new-password" onChange={(e) => setGMasterNew(e.target.value)} />
              </label>
              <label style={{ display: 'block', marginBottom: 6 }}>
                Mật khẩu SOS {gHasSos ? '(đã đặt — gõ vào ô mở khoá sẽ XOÁ TẤT CẢ)' : '(chưa đặt)'}
                <input type="password" style={inp} value={gSosNew} placeholder={gHasSos ? 'Nhập để ĐỔI' : 'Đặt mật khẩu SOS (khẩn cấp)'}
                  autoComplete="new-password" onChange={(e) => setGSosNew(e.target.value)} />
              </label>
              {gHasMaster && (
                <label style={{ display: 'block', marginBottom: 6 }}>
                  Xác nhận bằng mật khẩu chủ hiện tại
                  <input type="password" style={inp} value={gAuth} autoComplete="off"
                    onChange={(e) => setGAuth(e.target.value)} />
                </label>
              )}
              <div className="row-inline" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" disabled={!gMasterNew} onClick={() => void saveMaster(false)}>Lưu mật khẩu chủ</button>
                {gHasMaster && <button className="btn" onClick={() => void saveMaster(true)}>Gỡ mật khẩu chủ</button>}
                <button className="btn" disabled={!gSosNew} onClick={() => void saveSos(false)}>Lưu SOS</button>
                {gHasSos && <button className="btn" onClick={() => void saveSos(true)}>Gỡ SOS</button>}
                <button className="btn" onClick={() => void saveGuardLimits()}>Lưu giới hạn</button>
              </div>
              {gMsg && <p className="hint" style={{ marginBottom: 0 }}>{gMsg}</p>}

              <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0 6px', paddingTop: 8 }}>
                <b>🗂 Khoá theo nhóm</b>
                <p className="hint" style={{ marginTop: 2 }}>
                  Khoá cả một nhóm bằng <b>mã riêng</b>. Nhóm bị khoá sẽ <b>ẩn hẳn</b> khỏi danh sách; gõ
                  đúng mã (ở ô "🔒 Mã nhóm" cột trái) mới hiện. Nhập sai mã quá {gPerLimit} lần → xoá vĩnh viễn
                  cả nhóm; tổng sai chạm {gGlobalLimit} → xoá TẤT CẢ. Mật khẩu chủ mở được mọi nhóm.
                </p>
                {groupNames.length === 0 ? (
                  <p className="hint" style={{ margin: 0 }}>Chưa có nhóm nào. Tạo nhóm và gán profile vào nhóm trước.</p>
                ) : (
                  <div className="row-inline" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select
                      style={{ ...inp, maxWidth: 180 }}
                      value={gSelGroup}
                      onChange={(e) => { setGSelGroup(e.target.value); setGGroupCode(''); setGroupMsg('') }}
                    >
                      <option value="">— Chọn nhóm —</option>
                      {groupNames.map((n) => (
                        <option key={n} value={n}>{lockedGroupSet.has(n) ? '🔒 ' : ''}{n}</option>
                      ))}
                    </select>
                    {gSelGroup && (
                      <>
                        <input
                          type="password"
                          style={{ ...inp, maxWidth: 150 }}
                          placeholder={lockedGroupSet.has(gSelGroup) ? 'Mã mới (đổi)' : 'Đặt mã khoá'}
                          autoComplete="new-password"
                          value={gGroupCode}
                          onChange={(e) => setGGroupCode(e.target.value)}
                        />
                        <button className="btn" onClick={() => void saveGroupLock(false)}>
                          {lockedGroupSet.has(gSelGroup) ? 'Đổi mã' : 'Khoá'}
                        </button>
                        {lockedGroupSet.has(gSelGroup) && (
                          <button className="btn" style={{ color: '#e0534f' }} onClick={() => void saveGroupLock(true)}>Gỡ khoá</button>
                        )}
                      </>
                    )}
                  </div>
                )}
                {lockedGroupSet.size > 0 && (
                  <p className="hint" style={{ margin: '4px 0 0' }}>Đang khoá: {[...lockedGroupSet].join(', ')}</p>
                )}
                {groupMsg && <p className="hint" style={{ margin: 0 }}>{groupMsg}</p>}
              </div>

              <p className="hint" style={{ marginBottom: 0, color: '#e0534f' }}>
                ⚠️ Nếu đặt mật khẩu chủ mà quên, sẽ không gỡ/đổi được khoá nào nữa, và không mở lại được phần
                này (đúng tinh thần tự huỷ).
              </p>
            </section>
          )}

          <section className="card">
            <h3>Passkey — sao lưu</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              <b>Tự động theo tài khoản:</b> passkey của mọi profile được cất trong một <b>két riêng trên cloud</b>
              (mã hoá bằng khoá tài khoản). Đăng nhập tài khoản hoặc mở profile là app tự quét và kéo passkey về;
              tạo/xoá passkey tự đẩy lên. Xoá profile hay cài lại máy vẫn lấy lại được. Ngoài ra app giữ 5 bản sao
              cũ gần nhất trên máy này, và bạn có thể sao lưu ra file <code>.vgcpk</code> (mật khẩu riêng) để cất
              ngoài cloud.
            </p>
            <div className="row-inline" style={{ gap: 6, marginBottom: 8 }}>
              <button className="btn" onClick={() => void syncPasskeysNow()}>Đồng bộ két ngay</button>
            </div>
            <div className="row-inline" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="password"
                style={{ ...inp, maxWidth: 250 }}
                value={pkAllPass}
                placeholder="Mật khẩu file sao lưu (từ 8 ký tự)"
                autoComplete="new-password"
                onChange={(e) => setPkAllPass(e.target.value)}
              />
              <button className="btn" disabled={pkAllPass.length < 8} onClick={() => void backupAllPasskeys()}>
                Sao lưu tất cả
              </button>
              <button className="btn" disabled={pkAllPass.length < 8} onClick={() => void restoreAllPasskeys()}>
                Khôi phục từ file
              </button>
            </div>
            {pkAllMsg && <p className="hint" style={{ margin: '6px 0 0' }}>{pkAllMsg}</p>}
            <p className="hint" style={{ margin: '6px 0 0', color: '#e0534f' }}>
              ⚠️ Quên mật khẩu file sao lưu thì không mở lại được file. Cất file ở nơi an toàn (ổ D, USB).
            </p>
          </section>

          <section className="card">
            <h3>Giao diện</h3>
            <div className="seg">
              <button
                className={`seg-btn ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => onSetTheme('dark')}
              >
                Tối
              </button>
              <button
                className={`seg-btn ${theme === 'light' ? 'active' : ''}`}
                onClick={() => onSetTheme('light')}
              >
                Sáng
              </button>
            </div>
          </section>

          <section className="card">
            <h3>Nhà cung cấp Proxy — iProyal</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Nhập 1 lần ở đây, sau đó vào <b>Proxy</b> chỉ cần bấm <b>Tạo proxy</b>. Lấy{' '}
              <b>API token</b> tại{' '}
              <a
                href="https://dashboard.iproyal.com/me/settings"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Settings → API
              </a>
              ; <b>Username/Password</b> ở mục Residential → “Change proxies credentials”.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              <input
                placeholder="API token"
                value={ipToken}
                onChange={(e) => setIpToken(e.target.value)}
                style={inp}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  placeholder="Username"
                  value={ipUser}
                  onChange={(e) => setIpUser(e.target.value)}
                  style={inp}
                />
                <input
                  placeholder="Password"
                  type="password"
                  value={ipPass}
                  onChange={(e) => setIpPass(e.target.value)}
                  style={inp}
                />
              </div>
              <div className="proxy-check" style={{ alignItems: 'center', gap: 10 }}>
                <button className="btn primary" onClick={() => void saveIproyal()}>
                  Lưu tài khoản iProyal
                </button>
                {ipMsg && (
                  <span style={{ color: 'var(--green)', fontSize: 12 }}>{ipMsg}</span>
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Nhà cung cấp Proxy — Evomi</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Chỉ cần nhập <b>API key</b> — lấy tại{' '}
              <a
                href="https://my.evomi.com"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                my.evomi.com → Settings → API
              </a>
              . Sau đó vào <b>Proxy</b>, chọn nhà cung cấp <b>Evomi</b> + sản phẩm rồi bấm{' '}
              <b>Tạo proxy</b>.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              <input
                placeholder="API key Evomi"
                value={evoKey}
                onChange={(e) => setEvoKey(e.target.value)}
                style={inp}
              />
              <div className="proxy-check" style={{ alignItems: 'center', gap: 10 }}>
                <button className="btn primary" onClick={() => void saveEvomi()}>
                  Lưu API key Evomi
                </button>
                {evoMsg && (
                  <span style={{ color: 'var(--green)', fontSize: 12 }}>{evoMsg}</span>
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Nhà cung cấp Proxy — Cliproxy</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Nhập <b>host</b>, <b>port</b>, <b>username</b>, <b>password</b> — lấy tại{' '}
              <a
                href="https://dash.cliproxy.com"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                dash.cliproxy.com
              </a>
              . Sau đó vào <b>Proxy</b>, chọn nhà cung cấp <b>Cliproxy</b> rồi bấm <b>Tạo proxy</b>{' '}
              (mỗi proxy = 1 IP sticky riêng, tối đa 120 phút).
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  placeholder="Host (vd: us.cliproxy.io)"
                  value={cpHost}
                  onChange={(e) => setCpHost(e.target.value)}
                  style={{ ...inp, flex: 2 }}
                />
                <input
                  placeholder="Port"
                  value={cpPort}
                  onChange={(e) => setCpPort(e.target.value.replace(/[^0-9]/g, ''))}
                  style={{ ...inp, flex: 1 }}
                />
              </div>
              <input
                placeholder="Username Cliproxy"
                value={cpUser}
                onChange={(e) => setCpUser(e.target.value)}
                style={inp}
              />
              <input
                placeholder="Password Cliproxy"
                value={cpPass}
                onChange={(e) => setCpPass(e.target.value)}
                style={inp}
              />
              <input
                placeholder="State/bang mặc định (tùy chọn, vd: Louisiana)"
                value={cpState}
                onChange={(e) => setCpState(e.target.value)}
                style={inp}
              />
              <div className="proxy-check" style={{ alignItems: 'center', gap: 10 }}>
                <button className="btn primary" onClick={() => void saveCliproxy()}>
                  Lưu tài khoản Cliproxy
                </button>
                {cpMsg && <span style={{ color: 'var(--green)', fontSize: 12 }}>{cpMsg}</span>}
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Giải Captcha tự động — CapSolver</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Dán API key từ{' '}
              <a
                href="https://dashboard.capsolver.com"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                dashboard.capsolver.com
              </a>
              . Khi có key, tool <b>Đổi mật khẩu Gmail</b> sẽ tự giải captcha ảnh (và thử reCAPTCHA)
              gặp trong lúc đăng nhập/đổi mật khẩu. Bỏ trống = tự giải tay trên cửa sổ.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              <input
                placeholder="API key CapSolver (CAP-xxxxxxxx…)"
                value={capKey}
                onChange={(e) => setCapKey(e.target.value)}
                style={inp}
              />
              <div className="proxy-check" style={{ alignItems: 'center', gap: 10 }}>
                <button className="btn primary" onClick={() => void saveCapsolver()}>
                  Lưu API key CapSolver
                </button>
                {capMsg && <span style={{ color: 'var(--green)', fontSize: 12 }}>{capMsg}</span>}
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Phiên bản &amp; Cập nhật</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              VGC Browser {version ? `v${version}` : '…'}
            </p>
            <div className="proxy-check">
              {downloaded ? (
                <button className="btn primary" onClick={() => void window.vgc.installUpdate()}>
                  ⟳ Khởi động lại để cập nhật
                </button>
              ) : manual ? (
                <button className="btn primary" onClick={() => void window.vgc.openUpdateDownload()}>
                  Tải về để cập nhật
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={checking}
                  onClick={() => void window.vgc.checkForUpdate()}
                >
                  {checking ? 'Đang xử lý…' : 'Kiểm tra cập nhật'}
                </button>
              )}
            </div>
            {update && update.phase !== 'idle' && (
              <p className="hint" style={{ marginBottom: 0 }}>
                {updateLabel(update)}
              </p>
            )}
          </section>
        </div>

        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>
            Đóng
          </button>
        </footer>
      </div>
    </div>
  )
}
