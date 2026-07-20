import { useEffect, useState } from 'react'
import type { OsType, ProxyType, SavedProxy } from '../../shared/types'
import { parseLine } from '../lib/proxy-parse'

interface Props {
  groups: string[]
  defaultGroup?: string
  onClose: () => void
  onImported: () => void
  /** Auto-login the freshly created profiles into Gmail (if the checkbox is on). */
  onLogin?: (ids: string[]) => void
}

const OS_OPTIONS: Array<{ v: OsType; label: string; icon: string }> = [
  { v: 'windows', label: 'Windows', icon: '🪟' },
  { v: 'macos', label: 'macOS', icon: '' },
  { v: 'linux', label: 'Linux', icon: '🐧' },
  { v: 'android', label: 'Android', icon: '🤖' }
]
const HOST_OS: OsType = /Mac/i.test(navigator.userAgent)
  ? 'macos'
  : /Win/i.test(navigator.userAgent)
    ? 'windows'
    : /Android/i.test(navigator.userAgent)
      ? 'android'
      : 'linux'

/** Bulk-create profiles from a pasted account list. One line per account, columns separated by
 *  `|` or a tab:  email | password | proxy | 2FA-secret. Password/proxy/2FA are optional. */
export function BulkImportModal({
  groups,
  defaultGroup,
  onClose,
  onImported,
  onLogin
}: Props): JSX.Element {
  const [text, setText] = useState('')
  const [os, setOs] = useState<OsType>(HOST_OS)
  const [group, setGroup] = useState(defaultGroup ?? '')
  const [proxyType, setProxyType] = useState<ProxyType>('socks5')
  const [autoLogin, setAutoLogin] = useState(false)
  const [autoProxy, setAutoProxy] = useState(false)
  const [pool, setPool] = useState<SavedProxy[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [importedText, setImportedText] = useState('') // the text already imported — blocks a duplicate re-click

  useEffect(() => {
    void window.vgc
      .listProxies()
      .then(setPool)
      .catch(() => {})
  }, [])
  const freeCount = pool.filter((p) => !p.assignedTo).length

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const doImport = async (): Promise<void> => {
    if (!lines.length) {
      setMsg('Chưa dán tài khoản nào.')
      return
    }
    setBusy(true)
    setMsg(`Đang tạo ${lines.length} profile…`)
    let created = 0
    let badProxy = 0
    const createdIds: string[] = []
    // Auto-take free pool proxies (one per profile that has no proxy of its own on the line).
    const freeQueue = autoProxy ? pool.filter((p) => !p.assignedTo) : []
    const poolAssigned: Array<{ profileId: string; sp: SavedProxy }> = []
    let noProxyLeft = 0
    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(/[|\t]/).map((c) => c.trim())
      const email = cols[0] || ''
      const pass = cols[1] || ''
      const proxyStr = cols[2] || ''
      const twofa = cols[3] || ''
      const pp = proxyStr ? parseLine(proxyStr, proxyType) : null
      if (proxyStr && !pp) badProxy++
      // No proxy on the line → take one from the pool when "tự lấy proxy" is on.
      let poolSp: SavedProxy | null = null
      if (!pp && autoProxy) {
        poolSp = freeQueue.shift() ?? null
        if (!poolSp) noProxyLeft++
      }
      const cfg = pp ?? poolSp
      try {
        const p = await window.vgc.createProfile({
          name: email || `Acc ${i + 1}`,
          os,
          group: group || undefined,
          proxy: cfg
            ? {
                type: cfg.type,
                host: cfg.host,
                port: cfg.port,
                username: cfg.username,
                password: cfg.password
              }
            : { type: 'none' },
          account: {
            user: email || undefined,
            pass: pass || undefined,
            totp: twofa || undefined,
            status: 'ready'
          }
        })
        created++
        createdIds.push(p.id)
        if (poolSp) poolAssigned.push({ profileId: p.id, sp: poolSp })
      } catch {
        /* skip a bad line, keep importing the rest */
      }
    }
    // Mark taken pool proxies assigned to their new profile (1 proxy ↔ 1 profile).
    for (const { profileId, sp } of poolAssigned) {
      try {
        await window.vgc.saveProxy({ ...sp, assignedTo: profileId })
      } catch {
        /* pool bookkeeping only — never fail the import over it */
      }
    }
    // Refresh the local pool so a second import in the same modal doesn't hand out proxies that
    // this run just assigned (freeCount + freeQueue read from `pool`).
    if (poolAssigned.length) void window.vgc.listProxies().then(setPool).catch(() => {})
    onImported()
    setBusy(false)
    // Auto-login the new profiles into Gmail (checkbox) — the login batch runs in App (progress
    // shows in its banner), so just hand off the ids and close.
    if (created > 0 && autoLogin && onLogin) {
      onLogin(createdIds)
      onClose()
      return
    }
    // Remember what was imported so an immediate second click (the modal stays open on a
    // shortfall) can't create the same accounts again — there is no dedup in createProfile.
    if (created > 0) setImportedText(text)
    setMsg(
      `✓ Đã tạo ${created}/${lines.length} profile.` +
        (badProxy ? ` ⚠️ ${badProxy} dòng proxy sai định dạng.` : '') +
        (noProxyLeft ? ` ⚠️ ${noProxyLeft} profile không có proxy (kho hết proxy rảnh).` : '')
    )
    // Only auto-close on a FULLY successful run, so a partial "X/N" result stays visible.
    if (created === lines.length && !badProxy && !noProxyLeft) onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 620 }}>
        <header className="modal-head">
          <h2>Nhập tài khoản hàng loạt</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <label>
              Danh sách tài khoản{lines.length ? ` — ${lines.length} dòng` : ''}
              <textarea
                rows={8}
                autoFocus
                placeholder={
                  'Mỗi dòng 1 tài khoản, cột cách nhau bằng | hoặc tab:\n' +
                  'email | mật khẩu | proxy(host:port:user:pass) | 2FA\n\n' +
                  'vd: john@gmail.com | Pass123 | 1.2.3.4:8080:u:p | JBSWY3DPEHPK3PXP\n' +
                  'vd: mary@gmail.com | Pass456\n' +
                  '(mật khẩu / proxy / 2FA đều có thể để trống)'
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                style={{ width: '100%', fontFamily: 'ui-monospace,Consolas,monospace', marginTop: 4 }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
              <label style={{ margin: 0 }}>
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
              <label style={{ margin: 0 }}>
                Loại proxy (dòng không ghi scheme)
                <select
                  className="group-select"
                  style={{ width: '100%', marginTop: 4 }}
                  value={proxyType}
                  onChange={(e) => setProxyType(e.target.value as ProxyType)}
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                </select>
              </label>
            </div>

            <label style={{ marginTop: 12 }}>Hệ điều hành</label>
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
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={autoProxy}
                onChange={(e) => setAutoProxy(e.target.checked)}
                style={{ width: 'auto' }}
              />
              <span>
                📦 Tự lấy proxy rảnh từ kho cho dòng không ghi proxy (còn <b>{freeCount}</b> proxy
                rảnh — mỗi profile 1 cái)
              </span>
            </label>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={autoLogin}
                onChange={(e) => setAutoLogin(e.target.checked)}
                style={{ width: 'auto' }}
              />
              <span>🔑 Tự đăng nhập Gmail sau khi tạo (mở lần lượt, điền email/mật khẩu/2FA, đánh dấu Live/Die)</span>
            </label>
            <p className="hint">
              Mỗi profile: tên = email, có vân tay riêng, lưu mật khẩu + khóa 2FA + gán proxy. Trạng
              thái mặc định "Sẵn sàng".
            </p>
            {msg && (
              <p className="hint" style={{ color: msg.startsWith('Lỗi') || msg.includes('⚠️') ? '#ffd76a' : 'var(--green)' }}>
                {msg}
              </p>
            )}
          </section>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Đóng
          </button>
          <button
            className="btn primary"
            onClick={() => void doImport()}
            disabled={busy || !lines.length || text === importedText}
          >
            {busy
              ? 'Đang tạo…'
              : text === importedText && importedText
                ? 'Đã tạo (sửa danh sách để tạo tiếp)'
                : `Tạo ${lines.length || ''} profile`}
          </button>
        </footer>
      </div>
    </div>
  )
}
