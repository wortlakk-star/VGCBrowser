import { useEffect, useMemo, useRef, useState } from 'react'
import type { GmailChangeStatus, OsType, Profile, ProxyConfig, SavedProxy } from '../../shared/types'

interface Props {
  profiles: Profile[]
  proxies: SavedProxy[]
  onClose: () => void
  /** Called after the run so the parent can refresh its profile list (new profiles). */
  onChanged?: () => void
}

type RowStatus = 'pending' | 'running' | GmailChangeStatus
type PwMode = 'manual' | 'random'

interface Row {
  email: string
  oldPassword: string
  newPassword: string // manual value, or '' until a random one is generated at run time
  totpSecret?: string
  profileId: string | null
  profileName: string | null // '(sẽ tạo mới)' for a to-be-created profile
  willCreate: boolean
  status: RowStatus
  message: string
}

const STATUS_LABEL: Record<RowStatus, string> = {
  pending: 'Chờ',
  running: 'Đang chạy…',
  done: '✓ Đã đổi',
  wrong_password: '✗ Sai mật khẩu cũ',
  weak_password: '✗ Mật khẩu mới bị từ chối',
  captcha: '⚠ Dính captcha',
  needs_manual: '⚠ Cần xác minh tay',
  not_found: '✗ Không có profile',
  error: '✗ Lỗi'
}

const OK_TAG = 'gmail-ok'
const FAIL_TAG = 'gmail-lỗi'

function statusClass(s: RowStatus): string {
  if (s === 'done') return 'ok'
  if (s === 'pending' || s === 'running') return ''
  return 'err'
}

/** Does `notes` contain `email` as a whole token (not a substring of a longer email)? */
function notesHasEmail(notes: string, email: string): boolean {
  const n = notes.toLowerCase()
  let from = 0
  for (;;) {
    const i = n.indexOf(email, from)
    if (i === -1) return false
    const before = i > 0 ? n[i - 1] : ' '
    const after = i + email.length < n.length ? n[i + email.length] : ' '
    const emailChar = (c: string): boolean => /[a-z0-9._%+@-]/.test(c)
    if (!emailChar(before) && !emailChar(after)) return true
    from = i + email.length
  }
}

/** Find the profile that owns an email. Only an EXACT name match, or the email as a
 *  whole token in notes — NO loose substring (bob@x.com must not bind robert.bob@x.com). */
function matchProfile(email: string, profiles: Profile[]): Profile | null {
  const e = email.trim().toLowerCase()
  if (!e) return null
  const exact = profiles.find((p) => p.name.trim().toLowerCase() === e)
  if (exact) return exact
  return profiles.find((p) => notesHasEmail(p.notes || '', e)) ?? null
}

interface ParsedLine {
  email: string
  oldPassword: string
  newPassword: string
  totpSecret: string
  tooMany: boolean // more than 4 columns → the password probably contains the delimiter
}

/** Parse one line into fields. Only email + old are required. Reports `tooMany` when
 *  there are >4 columns so we NEVER silently truncate a password to a wrong value. */
function parseLine(line: string): ParsedLine | null {
  const delim = line.includes('|') ? '|' : line.includes('\t') ? '\t' : ','
  const parts = line.split(delim)
  const [email, oldPassword, newPassword, totpSecret] = parts.map((p) => (p ?? '').trim())
  if (!email || !oldPassword) return null
  return {
    email,
    oldPassword,
    newPassword: newPassword || '',
    totpSecret: totpSecret || '',
    tooMany: parts.length > 4
  }
}

/** A real base32 2FA key is ≥16 base32 chars. Catches a mistakenly-pasted 6-digit code. */
function totpSecretIssue(secret: string): string | null {
  if (!secret) return null
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '')
  if (clean.length < 16) return 'Khóa 2FA không hợp lệ (cần khóa bí mật, không phải mã 6 số)'
  return null
}

/** Cryptographically-random strong password (upper/lower/digit/symbol, ambiguous
 *  chars removed) that satisfies Google's requirements. */
function randomPassword(len = 14): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digit = '23456789'
  const sym = '!@#%^&*-_=+'
  const all = upper + lower + digit + sym
  const rnd = (n: number): number => {
    const a = new Uint32Array(1)
    crypto.getRandomValues(a)
    return Math.floor((a[0] / 2 ** 32) * n)
  }
  const pick = (set: string): string => set[rnd(set.length)]
  const out = [pick(upper), pick(lower), pick(digit), pick(sym)]
  for (let i = out.length; i < len; i++) out.push(pick(all))
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out.join('')
}

function toProxyConfig(p: SavedProxy): ProxyConfig {
  return { type: p.type, host: p.host, port: p.port, username: p.username, password: p.password }
}

export function GmailPasswordModal({ profiles, proxies, onClose, onChanged }: Props): JSX.Element {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [pwMode, setPwMode] = useState<PwMode>('manual')
  const [autoCreate, setAutoCreate] = useState(true)
  const [os, setOs] = useState<OsType>('windows')
  const [logPath, setLogPath] = useState('')
  const abortRef = useRef(false)

  // Live per-account progress from the main process.
  useEffect(() => {
    const off = window.vgc.onGmailProgress((p) => {
      setRows((rs) =>
        rs.map((r) =>
          r.email.toLowerCase() === p.email.toLowerCase() && r.status === 'running'
            ? { ...r, message: p.message }
            : r
        )
      )
    })
    return off
  }, [])

  // Existing profile id → its current tags, for merge-on-mark.
  const tagMap = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of profiles) m.set(p.id, p.tags ?? [])
    return m
  }, [profiles])

  const parsed = useMemo(() => {
    const out: Row[] = []
    const seen = new Set<string>()
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const p = parseLine(line)
      if (!p) continue
      const key = p.email.toLowerCase()
      const prof = matchProfile(p.email, profiles)
      const willCreate = !prof && autoCreate

      let status: RowStatus = 'pending'
      let message = totpSecretIssue(p.totpSecret) ?? ''
      let profileName: string | null = prof?.name ?? null

      if (seen.has(key)) {
        status = 'error'
        message = 'Trùng email với dòng trên'
      } else if (p.tooMany) {
        status = 'error'
        message = 'Dòng có hơn 4 cột — mật khẩu chứa ký tự phân cách (| , tab)? Sửa lại.'
      } else if (pwMode === 'manual' && !p.newPassword) {
        status = 'error'
        message = 'Thiếu mật khẩu mới (hoặc chọn chế độ Ngẫu nhiên)'
      } else if (!prof && !autoCreate) {
        status = 'not_found'
        message = 'Không tìm thấy profile khớp email này'
      } else if (willCreate) {
        profileName = '(sẽ tạo mới)'
      }
      seen.add(key)

      out.push({
        email: p.email,
        oldPassword: p.oldPassword,
        newPassword: p.newPassword,
        totpSecret: p.totpSecret || undefined,
        profileId: prof?.id ?? null,
        profileName,
        willCreate,
        status,
        message
      })
    }
    return out
  }, [text, profiles, pwMode, autoCreate])

  const preview = (): void => setRows(parsed)

  const source = running ? rows : parsed
  const runnableCount = source.filter((r) => r.status === 'pending').length
  const willCreateCount = source.filter((r) => r.willCreate && r.status === 'pending').length

  const markProfile = async (
    profileId: string,
    baseTags: string[],
    status: GmailChangeStatus
  ): Promise<void> => {
    const marker = status === 'done' ? OK_TAG : FAIL_TAG
    const next = Array.from(new Set([...baseTags.filter((t) => t !== OK_TAG && t !== FAIL_TAG), marker]))
    try {
      await window.vgc.updateProfile(profileId, { tags: next })
    } catch {
      // marking is best-effort — never fail the run over a tag write
    }
  }

  const run = async (): Promise<void> => {
    // Preserve accounts already changed in a PRIOR run of this session so a second
    // click never re-drives them with the now-invalid old password.
    const doneEmails = new Set(
      rows.filter((r) => r.status === 'done').map((r) => r.email.toLowerCase())
    )
    const work = parsed.map((r) =>
      doneEmails.has(r.email.toLowerCase())
        ? { ...r, status: 'done' as RowStatus, message: 'Đã đổi ở lần chạy trước (bỏ qua)' }
        : { ...r }
    )
    setRows(work)
    setRunning(true)
    abortRef.current = false

    // Proxies already used by existing profiles + ones we assign during this run.
    const usedProxy = new Set<string>()
    for (const p of profiles) {
      if (p.proxy?.host) usedProxy.add(`${p.proxy.host}:${p.proxy.port}`)
    }
    const pickProxy = (): { cfg: ProxyConfig; warn?: string } => {
      if (!proxies.length) return { cfg: { type: 'none' }, warn: 'không có proxy trong kho' }
      const avail = proxies.filter((p) => !usedProxy.has(`${p.host}:${p.port}`))
      const pool = avail.length ? avail : proxies
      const chosen = pool[Math.floor(Math.random() * pool.length)]
      usedProxy.add(`${chosen.host}:${chosen.port}`)
      return { cfg: toProxyConfig(chosen), warn: avail.length ? undefined : 'proxy đã dùng hết → tái sử dụng' }
    }

    const patch = (i: number, p: Partial<Row>): void =>
      setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, ...p } : x)))

    let createdAny = false

    // Sequential: one visible browser at a time — safest for Google, and lets the
    // user clear a live 2FA/captcha challenge on the one window that's open.
    for (let i = 0; i < work.length; i++) {
      if (abortRef.current) break
      const r = work[i]
      if (r.status !== 'pending') continue // errors / not_found / already-done rows

      const newPassword = pwMode === 'random' ? randomPassword() : r.newPassword

      let profileId = r.profileId
      let baseTags = profileId ? tagMap.get(profileId) ?? [] : []

      // Create a profile for an unmatched email (name = email so it re-matches later).
      if (!profileId) {
        if (!autoCreate) {
          patch(i, { status: 'not_found', message: 'Không có profile (bật "Tự tạo profile")' })
          continue
        }
        patch(i, { status: 'running', message: 'Đang tạo profile…', newPassword })
        try {
          const { cfg, warn } = pickProxy()
          const created = await window.vgc.createProfile({
            name: r.email,
            notes: r.email,
            os,
            proxy: cfg,
            startUrls: []
          })
          profileId = created.id
          baseTags = created.tags ?? []
          createdAny = true
          patch(i, {
            profileId,
            profileName: created.name,
            message: warn ? `Đã tạo profile (${warn})` : 'Đã tạo profile'
          })
        } catch (e) {
          patch(i, { status: 'error', message: 'Tạo profile lỗi: ' + (e instanceof Error ? e.message : String(e)) })
          continue
        }
      }

      patch(i, { status: 'running', message: 'Đang mở…', newPassword })
      let result: GmailChangeStatus = 'error'
      try {
        const res = await window.vgc.changeGmailPassword(profileId, {
          email: r.email,
          oldPassword: r.oldPassword,
          newPassword,
          totpSecret: r.totpSecret
        })
        result = res.status
        patch(i, { status: res.status, message: res.message, newPassword })
        await markProfile(profileId, baseTags, res.status)
      } catch (e) {
        patch(i, { status: 'error', message: e instanceof Error ? e.message : String(e) })
        await markProfile(profileId, baseTags, 'error')
      }
      // Durably record the outcome (incl. any random password) the instant it's known,
      // so a crash / close can never lose it.
      try {
        const path = await window.vgc.logGmailResult(`${r.email}|${newPassword}|${result}`)
        if (path && !logPath) setLogPath(path)
      } catch {
        // best-effort
      }
    }
    setRunning(false)
    if (createdAny) onChanged?.()
  }

  const exportResults = (): void => {
    // Download only — NO silent clipboard write (that would leak plaintext passwords).
    const lines = rows.map((r) => `${r.email}|${r.newPassword}|${STATUS_LABEL[r.status]}`).join('\n')
    const blob = new Blob([lines], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'gmail-password-results.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const display = rows.length ? rows : parsed

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 820 }}>
        <header className="modal-head">
          <h3>🔑 Đổi mật khẩu Gmail hàng loạt</h3>
          <button className="btn" onClick={onClose} disabled={running}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <p className="hint">
              Mỗi dòng một tài khoản: <b>email | mật khẩu cũ | mật khẩu mới | khóa 2FA</b>. Cột{' '}
              <b>mật khẩu mới</b> và <b>khóa 2FA</b> là tùy chọn. Ở chế độ <b>Ngẫu nhiên</b> tool tự
              sinh mật khẩu mạnh (bỏ trống cột 3). Khóa 2FA là <b>khóa bí mật</b> (kiểu{' '}
              <span className="mono">JBSWY3DPEHPK3PXP</span>, KHÔNG phải mã 6 số).
            </p>
            <textarea
              rows={7}
              placeholder={
                'sandie16022006@gmail.com | Sandie2006@? | Jeco123123\nsechristula164@gmail.com | Ula2006?! |  | JBSWY3DPEHPK3PXP'
              }
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setRows([]) // editing invalidates any previewed/result rows
              }}
              disabled={running}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
            />

            <div className="row" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 10, alignItems: 'center' }}>
              <span className="small">
                <b>Mật khẩu mới:</b>{' '}
                <label>
                  <input
                    type="radio"
                    checked={pwMode === 'manual'}
                    onChange={() => setPwMode('manual')}
                    disabled={running}
                  />{' '}
                  Tôi nhập
                </label>{' '}
                <label style={{ marginLeft: 8 }}>
                  <input
                    type="radio"
                    checked={pwMode === 'random'}
                    onChange={() => setPwMode('random')}
                    disabled={running}
                  />{' '}
                  Ngẫu nhiên
                </label>
              </span>

              <label className="small">
                <input
                  type="checkbox"
                  checked={autoCreate}
                  onChange={(e) => setAutoCreate(e.target.checked)}
                  disabled={running}
                />{' '}
                Tự tạo profile cho email chưa có (gán IP ngẫu nhiên chưa dùng)
              </label>

              <label className="small">
                OS profile mới:{' '}
                <select value={os} onChange={(e) => setOs(e.target.value as OsType)} disabled={running}>
                  <option value="windows">Windows</option>
                  <option value="macos">macOS</option>
                  <option value="linux">Linux</option>
                  <option value="android">Android</option>
                </select>
              </label>
            </div>

            <div className="hint" style={{ marginTop: 8 }}>
              {parsed.length} dòng hợp lệ · sẽ chạy {runnableCount}
              {willCreateCount ? ` · tạo mới ${willCreateCount} profile` : ''} · kho proxy {proxies.length}.
              Kết quả (kể cả mật khẩu ngẫu nhiên) tự lưu vào <span className="mono">gmail-password-log.txt</span>.
              Profile lỗi gắn tag <span className="mono">{FAIL_TAG}</span>, xong gắn{' '}
              <span className="mono">{OK_TAG}</span>.
            </div>
            {logPath && (
              <div className="hint" style={{ marginTop: 4 }}>
                Đã lưu kết quả tại: <span className="mono">{logPath}</span>
              </div>
            )}
          </section>

          {display.length > 0 && (
            <section className="card">
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                      <th style={{ padding: '4px 8px' }}>Email</th>
                      <th style={{ padding: '4px 8px' }}>Profile</th>
                      <th style={{ padding: '4px 8px' }}>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {display.map((r, i) => (
                      <tr key={`${r.email}-${i}`} style={{ borderTop: '1px solid rgba(128,128,128,0.2)' }}>
                        <td className="mono small" style={{ padding: '4px 8px' }}>
                          {r.email}
                          {r.totpSecret ? <span title="Có khóa 2FA"> 🔐</span> : ''}
                        </td>
                        <td className="small" style={{ padding: '4px 8px' }}>
                          {r.profileName ?? '—'}
                        </td>
                        <td className={`small ${statusClass(r.status)}`} style={{ padding: '4px 8px' }}>
                          {STATUS_LABEL[r.status]}
                          {r.message ? ` — ${r.message}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={running}>
            Đóng
          </button>
          {rows.some((r) => r.status !== 'pending' && r.status !== 'running') && (
            <button className="btn" onClick={exportResults}>
              Xuất kết quả
            </button>
          )}
          {running ? (
            <button className="btn danger" onClick={() => (abortRef.current = true)}>
              Dừng sau dòng này
            </button>
          ) : (
            <>
              <button className="btn" onClick={preview} disabled={!parsed.length}>
                Xem trước
              </button>
              <button className="btn primary" onClick={() => void run()} disabled={!runnableCount}>
                Bắt đầu ({runnableCount})
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
