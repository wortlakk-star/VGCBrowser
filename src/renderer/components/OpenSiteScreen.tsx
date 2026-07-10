import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OpenSiteStatus, OpenSiteFetchResult } from '../../shared/types'

// A read-only viewer over the OpenSite platform. The user signs in with their own
// admin/master credentials; the main process holds the token and proxies REST
// calls. Rendering is intentionally schema-agnostic: each tab asks for the first
// endpoint (by role) that answers, then a generic renderer turns whatever JSON
// comes back into stat cards + tables — so it keeps working if OpenSite tweaks a
// field name.

interface Tab {
  key: string
  label: string
  /** Candidate endpoints, tried in order (admin → master → seller). */
  paths: string[]
}

// Endpoints are probed live against api-v2.opensitex.store: each list is tried in
// order and the first that answers (by the token's role) wins. Admin paths come
// first, then seller, then master — a wrong-role call returns 403 and falls
// through to the next candidate. Only routes confirmed to exist are listed.
const TABS: Tab[] = [
  {
    key: 'overview',
    label: 'Tổng quan',
    paths: [
      '/admin/analytics/overview',
      '/seller/analytics/overview',
      '/master/analytics/date',
      '/master/analytics/admin'
    ]
  },
  { key: 'orders', label: 'Đơn hàng', paths: ['/admin/orders', '/seller/orders'] },
  { key: 'products', label: 'Sản phẩm', paths: ['/admin/products', '/seller/stores'] },
  { key: 'sellers', label: 'Người bán', paths: ['/admin/intermediary-sellers', '/admin/domains'] },
  {
    key: 'analytics',
    label: 'Doanh thu / Phân tích',
    paths: [
      '/admin/analytics/date',
      '/seller/analytics/sales-report',
      '/admin/analytics/overview',
      '/master/analytics/date'
    ]
  },
  { key: 'payments', label: 'Thanh toán', paths: ['/admin/payments', '/seller/stores'] }
]

const numFmt = new Intl.NumberFormat('vi-VN')

function isMoneyKey(k: string): boolean {
  return /revenue|amount|total|price|doanh\s*thu|gia|tien|balance|payout|profit|sales/i.test(k)
}

function formatValue(key: string, v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') {
    if (isMoneyKey(key)) return numFmt.format(v) + ' ₫'
    return numFmt.format(v)
  }
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  if (typeof v === 'string') {
    // ISO date → local
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v)
      if (!isNaN(d.getTime())) return d.toLocaleString('vi-VN')
    }
    return v
  }
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return String(o.name ?? o.title ?? o.email ?? o.id ?? JSON.stringify(v).slice(0, 40))
  }
  return String(v)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Pull scalar (number/string/bool) fields off an object → for stat cards. */
function scalarEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(obj).filter(
    ([, v]) => v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
  )
}

/** Find every array-of-objects hanging off an object, as [label, rows]. */
function findTables(obj: Record<string, unknown>): Array<[string, Array<Record<string, unknown>>]> {
  const out: Array<[string, Array<Record<string, unknown>>]> = []
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length && v.every((x) => isObj(x))) {
      out.push([k, v as Array<Record<string, unknown>>])
    }
  }
  return out
}

function columnsOf(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>()
  for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) seen.add(k)
  const all = [...seen]
  // Prefer human-meaningful columns first, cap to keep the table readable.
  const priority = ['id', 'code', 'name', 'title', 'email', 'status', 'state', 'role', 'quantity', 'qty']
  all.sort((a, b) => {
    const pa = priority.indexOf(a.toLowerCase())
    const pb = priority.indexOf(b.toLowerCase())
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb)
  })
  return all.slice(0, 9)
}

function DataTable({ rows }: { rows: Array<Record<string, unknown>> }): JSX.Element {
  const cols = columnsOf(rows)
  return (
    <div className="os-tablewrap">
      <table className="os-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} title={typeof r[c] === 'object' ? JSON.stringify(r[c]) : undefined}>
                  {formatValue(c, r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && <div className="os-more">… và {numFmt.format(rows.length - 200)} dòng nữa</div>}
    </div>
  )
}

function StatCards({ entries }: { entries: Array<[string, unknown]> }): JSX.Element {
  return (
    <div className="os-stats">
      {entries.map(([k, v]) => (
        <div className="os-stat" key={k}>
          <div className="os-stat-n">{formatValue(k, v)}</div>
          <div className="os-stat-l">{k}</div>
        </div>
      ))}
    </div>
  )
}

/** Turn any JSON payload into cards + tables. */
function GenericView({ data }: { data: unknown }): JSX.Element {
  if (Array.isArray(data)) {
    if (data.length && data.every((x) => isObj(x))) {
      return <DataTable rows={data as Array<Record<string, unknown>>} />
    }
    return <pre className="os-raw">{JSON.stringify(data, null, 2)}</pre>
  }
  if (isObj(data)) {
    const scalars = scalarEntries(data)
    const tables = findTables(data)
    return (
      <div>
        {scalars.length > 0 && <StatCards entries={scalars} />}
        {tables.map(([label, rows]) => (
          <div key={label} className="os-section">
            <div className="os-section-title">{label} · {numFmt.format(rows.length)}</div>
            <DataTable rows={rows} />
          </div>
        ))}
        {scalars.length === 0 && tables.length === 0 && (
          <pre className="os-raw">{JSON.stringify(data, null, 2)}</pre>
        )}
      </div>
    )
  }
  return <div className="os-empty">{data == null ? 'Không có dữ liệu.' : String(data)}</div>
}

interface Props {
  onExit: () => void
}

export function OpenSiteScreen({ onExit }: Props): JSX.Element {
  const [status, setStatus] = useState<OpenSiteStatus | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [totp, setTotp] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [authError, setAuthError] = useState('')

  const [tab, setTab] = useState('overview')
  const [result, setResult] = useState<OpenSiteFetchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    void window.vgc.opensiteStatus().then((s) => {
      setStatus(s)
      if (s.email) setEmail(s.email)
    })
  }, [])

  const loggedIn = !!status?.loggedIn

  const loadTab = useCallback(async (t: Tab) => {
    setLoading(true)
    setResult(null)
    try {
      const r = await window.vgc.opensiteFetch(t.paths)
      setResult(r)
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch whenever the active tab changes (once logged in).
  useEffect(() => {
    if (!loggedIn) return
    const t = TABS.find((x) => x.key === tab)
    if (t) void loadTab(t)
  }, [tab, loggedIn, loadTab])

  const doLogin = useCallback(async () => {
    setBusy(true)
    setAuthError('')
    try {
      const r = await window.vgc.opensiteLogin(email.trim(), password, remember)
      if (r.ok && r.status) {
        setStatus(r.status)
        setPassword('')
      } else if (r.twoFactorRequired) {
        setNeedTotp(true)
      } else {
        setAuthError(r.error || 'Đăng nhập thất bại.')
      }
    } finally {
      setBusy(false)
    }
  }, [email, password, remember])

  const doVerify = useCallback(async () => {
    setBusy(true)
    setAuthError('')
    try {
      const r = await window.vgc.opensiteVerifyTotp(totp)
      if (r.ok && r.status) {
        setStatus(r.status)
        setNeedTotp(false)
        setPassword('')
        setTotp('')
      } else {
        setAuthError(r.error || 'Mã 2FA không đúng.')
      }
    } finally {
      setBusy(false)
    }
  }, [totp])

  const doLogout = useCallback(async () => {
    const s = await window.vgc.opensiteLogout()
    setStatus(s)
    setResult(null)
    setNeedTotp(false)
    setPassword('')
  }, [])

  // ── Login view ──────────────────────────────────────────────────────────────
  if (!loggedIn) {
    return (
      <div className="os-login">
        <div className="os-login-card">
          <div className="os-login-head">
            <h2>OpenSite Dashboard</h2>
            <p className="hint">Đăng nhập bằng tài khoản admin/master của anh để xem đơn hàng, sản phẩm, doanh thu, seller.</p>
          </div>
          {!needTotp ? (
            <>
              <label className="os-field">
                <span>Email</span>
                <input
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && document.getElementById('os-pw')?.focus()}
                  placeholder="email@..."
                />
              </label>
              <label className="os-field">
                <span>Mật khẩu</span>
                <input
                  id="os-pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !busy && void doLogin()}
                  placeholder="••••••••"
                />
              </label>
              <label className="os-remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>Ghi nhớ đăng nhập trên máy này</span>
              </label>
              {authError && <div className="os-error">{authError}</div>}
              <button className="btn primary os-submit" disabled={busy || !email || !password} onClick={() => void doLogin()}>
                {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
              </button>
            </>
          ) : (
            <>
              <p className="hint">Nhập mã xác thực 2 lớp (6 số) từ ứng dụng Authenticator.</p>
              <label className="os-field">
                <span>Mã 2FA</span>
                <input
                  autoFocus
                  inputMode="numeric"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && !busy && void doVerify()}
                  placeholder="000000"
                />
              </label>
              {authError && <div className="os-error">{authError}</div>}
              <button className="btn primary os-submit" disabled={busy || totp.length < 6} onClick={() => void doVerify()}>
                {busy ? 'Đang xác thực…' : 'Xác thực'}
              </button>
              <button className="btn ghost" onClick={() => { setNeedTotp(false); setAuthError('') }}>
                ← Quay lại
              </button>
            </>
          )}
          <button className="btn ghost os-back" onClick={onExit}>← Về danh sách profile</button>
        </div>
      </div>
    )
  }

  // ── Dashboard view ────────────────────────────────────────────────────────────
  const activeTab = TABS.find((x) => x.key === tab)
  return (
    <div className="os-wrap">
      <div className="os-topbar">
        <div className="os-account">
          <strong>OpenSite</strong>
          <span className="os-role">{status?.role || 'user'}</span>
          <span className="os-email">{status?.email}</span>
        </div>
        <div className="os-actions">
          <button className="btn" onClick={() => activeTab && void loadTab(activeTab)} disabled={loading}>
            {loading ? '↻ Đang tải…' : '↻ Làm mới'}
          </button>
          <button className="btn ghost" onClick={onExit}>Profile</button>
          <button className="btn danger" onClick={() => void doLogout()}>Đăng xuất</button>
        </div>
      </div>

      <div className="os-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`os-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="os-content">
        {loading ? (
          <div className="os-empty">Đang tải dữ liệu…</div>
        ) : !result ? (
          <div className="os-empty">—</div>
        ) : !result.ok ? (
          <div className="os-error">
            Không tải được: {result.error || `HTTP ${result.status}`}
            {result.status === 403 && <div className="hint">Tài khoản của anh không có quyền xem mục này.</div>}
          </div>
        ) : (
          <>
            <div className="os-source">
              Nguồn: <code>{result.path}</code>
              <button className="os-rawtoggle" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? 'Xem bảng' : 'Xem JSON thô'}
              </button>
            </div>
            {showRaw ? (
              <pre className="os-raw">{JSON.stringify(result.data, null, 2)}</pre>
            ) : (
              <GenericView data={result.data} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
