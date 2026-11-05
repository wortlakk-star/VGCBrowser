// ── Chuyển dữ liệu sang máy chủ công ty ─────────────────────────────────────
// 1) đẩy nốt mọi profile/proxy/passkey/khoá trên máy này lên cloud (không ghi đè bản mới hơn);
// 2) máy chủ công ty tự chép tài khoản từ cloud sang, giữ nguyên mã tài khoản, đối chiếu từng byte;
// 3) hiện biên bản. Cloud không bị sửa/xoá gì. Bấm lại bao nhiêu lần cũng được (chỉ chép phần đổi).
import { useEffect, useRef, useState } from 'react'
import type { MigrationStatus } from '../../shared/types'
import { Icon } from './Icon'
import { pushCloudProfileList, pushCloudProxies } from '../cloud'

type StepState = 'wait' | 'run' | 'ok' | 'warn' | 'err'
interface Step {
  key: string
  label: string
  state: StepState
  detail?: string
}

const STEPS: Step[] = [
  { key: 'check', label: 'Kiểm tra máy (đã đóng hết profile, đã mở khoá mã hoá)', state: 'wait' },
  { key: 'sessions', label: 'Đẩy phiên đăng nhập của từng profile trên máy này lên cloud', state: 'wait' },
  { key: 'lists', label: 'Đẩy danh sách profile và proxy lên cloud', state: 'wait' },
  { key: 'vault', label: 'Đẩy két passkey và cấu hình khoá lên cloud', state: 'wait' },
  { key: 'server', label: 'Máy chủ công ty chép dữ liệu từ cloud và đối chiếu từng byte', state: 'wait' }
]

export const MIGRATED_KEY = 'vgc.migratedToCompanyServer'

function classifyUploadError(msg: string): 'newer' | 'empty' | 'warn' {
  if (/bản (cloud|trên máy chủ) đã mới hơn|không có dấu đồng bộ cục bộ/.test(msg)) return 'newer'
  if (/snapshot local đang trống|chưa hoàn chỉnh|chưa có dữ liệu|ENOENT/i.test(msg)) return 'empty'
  return 'warn'
}

export function MigrateModal({ email, onClose }: { email: string; onClose: () => void }): JSX.Element {
  const [password, setPassword] = useState('')
  const [full, setFull] = useState(false)
  const [phase, setPhase] = useState<'intro' | 'running' | 'done'>('intro')
  const [steps, setSteps] = useState<Step[]>(STEPS)
  const [status, setStatus] = useState<MigrationStatus | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [fatal, setFatal] = useState('')
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const set = (key: string, state: StepState, detail?: string): void =>
    setSteps((s) => s.map((x) => (x.key === key ? { ...x, state, detail } : x)))

  const run = async (): Promise<void> => {
    setPhase('running')
    setSteps(STEPS)
    setStatus(null)
    setWarnings([])
    setFatal('')
    const warn: string[] = []
    try {
      // 1. Kiểm tra
      set('check', 'run')
      const states = await window.vgc.runtimeStates()
      const open = states.filter((s) => s.status !== 'stopped' && s.status !== 'error')
      if (open.length) throw new Error(`Còn ${open.length} profile đang mở — đóng hết profile rồi bấm lại.`)
      const enc = await window.vgc.cloudEncryptionStatus()
      if (!enc.configured || !enc.unlocked) throw new Error('Cần mở khoá mã hoá Cloud trong Cài đặt trước.')
      set('check', 'ok')

      // 2. Phiên từng profile
      set('sessions', 'run')
      const locals = await window.vgc.listProfiles()
      let pushed = 0
      let newer = 0
      let empty = 0
      for (let i = 0; i < locals.length; i++) {
        if (!alive.current) return
        set('sessions', 'run', `${i + 1}/${locals.length}`)
        try {
          await window.vgc.cloudUploadData(locals[i].id)
          pushed++
        } catch (e) {
          const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
          const kind = classifyUploadError(msg)
          if (kind === 'newer') newer++
          else if (kind === 'empty') empty++
          else warn.push(`${locals[i].name || locals[i].id}: ${msg}`)
        }
      }
      const parts = [`đã đẩy ${pushed}`]
      if (newer) parts.push(`${newer} cloud đã có bản mới hơn (giữ bản cloud)`)
      if (empty) parts.push(`${empty} chưa từng mở (không có phiên)`)
      const failed = locals.length - pushed - newer - empty
      if (failed) parts.push(`${failed} lỗi`)
      set('sessions', failed ? 'warn' : 'ok', parts.join(' · '))

      // 3. Danh sách
      set('lists', 'run')
      const nProfiles = await pushCloudProfileList(true)
      const nProxies = await pushCloudProxies()
      set('lists', 'ok', `${nProfiles} profile · ${nProxies} proxy`)

      // 4. Két passkey + khoá
      set('vault', 'run')
      const prep = await window.vgc.migratePrepare()
      if (!prep.passkeys.ok) throw new Error(`Không đẩy được két passkey: ${prep.passkeys.error ?? 'không rõ'}`)
      if (!prep.guard.ok) warn.push(`Cấu hình khoá: ${prep.guard.error ?? 'không đẩy được'}`)
      set('vault', prep.guard.ok ? 'ok' : 'warn', `${prep.passkeys.total ?? 0} passkey`)

      // 5. Máy chủ chép
      set('server', 'run', 'đang kết nối máy chủ công ty…')
      const job = await window.vgc.migrateStart(password, full)
      setPassword('')
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000))
        if (!alive.current) return
        const st = await window.vgc.migrateStatus(job)
        setStatus(st)
        set('server', 'run', st.total ? `${st.step} (${st.done}/${st.total})` : st.step)
        if (st.state === 'done') {
          set('server', st.ok ? 'ok' : 'err', st.step)
          if (st.ok) {
            try {
              localStorage.setItem(MIGRATED_KEY, new Date().toISOString())
            } catch {
              /* chỉ là nhắc nhở */
            }
          }
          break
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      setFatal(msg)
      setSteps((s) => s.map((x) => (x.state === 'run' ? { ...x, state: 'err', detail: msg } : x)))
    } finally {
      setWarnings(warn)
      setPhase('done')
    }
  }

  const r = status?.report
  const icon = (s: StepState): JSX.Element =>
    s === 'ok' ? (
      <Icon name="check" size={16} style={{ color: 'var(--green)' }} />
    ) : s === 'err' ? (
      <Icon name="x" size={16} style={{ color: 'var(--red, #ff7a76)' }} />
    ) : s === 'warn' ? (
      <span style={{ color: '#f5c26b', fontWeight: 700 }}>!</span>
    ) : s === 'run' ? (
      <span className="spin" style={{ color: 'var(--accent, #2bd6c2)' }}>●</span>
    ) : (
      <span style={{ color: 'var(--dim)' }}>○</span>
    )

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="cloud" size={18} style={{ color: 'var(--green)' }} />
            Chuyển dữ liệu sang máy chủ công ty
          </h2>
          {phase !== 'running' && (
            <button className="btn" onClick={onClose}>
              <Icon name="x" size={16} strokeWidth={2.4} />
            </button>
          )}
        </header>
        <div className="modal-body">
          {phase === 'intro' && (
            <>
              <p style={{ marginTop: 0, lineHeight: 1.6 }}>
                Công ty chuyển toàn bộ dữ liệu VGC từ cloud về <b>máy chủ riêng của công ty</b>. Bấm một lần là xong: mọi
                profile, phiên đăng nhập, mật khẩu, mã 2FA, <b>passkey</b>, proxy và cấu hình khoá của tài khoản{' '}
                <b>{email}</b> được chép sang và <b>đối chiếu từng byte</b>.
              </p>
              <ul className="hint" style={{ lineHeight: 1.6, paddingLeft: 18 }}>
                <li>Cloud không bị sửa hay xoá gì — bạn vẫn làm việc bình thường.</li>
                <li>Đóng hết profile trước khi bấm. Thường mất dưới 1 phút.</li>
                <li>Bấm lại bao nhiêu lần cũng được — lần sau chỉ chép phần thay đổi.</li>
              </ul>
              <label className="field" style={{ display: 'block', marginTop: 12 }}>
                <span>Mật khẩu VGC của bạn (để máy chủ xác nhận đúng chủ tài khoản)</span>
                <input
                  type="password"
                  value={password}
                  autoFocus
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && password && void run()}
                  placeholder="Mật khẩu đăng nhập VGC"
                  style={{ width: '100%' }}
                />
              </label>
              <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
                <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />
                Kiểm tra lại toàn bộ (chép lại cả file không đổi — chậm hơn)
              </label>
            </>
          )}

          {phase !== 'intro' && (
            <div className="card" style={{ padding: 14 }}>
              {steps.map((s) => (
                <div key={s.key} style={{ display: 'flex', gap: 10, padding: '6px 0', alignItems: 'flex-start' }}>
                  <div style={{ width: 18, textAlign: 'center', paddingTop: 1 }}>{icon(s.state)}</div>
                  <div>
                    <div>{s.label}</div>
                    {s.detail && <div className="hint" style={{ fontSize: 12 }}>{s.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {phase === 'done' && r && (
            <div className="card" style={{ padding: 14, marginTop: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8, color: status?.ok ? 'var(--green)' : '#ff7a76' }}>
                {status?.ok ? '✓ Đã chuyển xong — khớp 100%' : '✗ Chưa khớp hết — báo quản trị'}
              </div>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <tbody>
                  {[
                    ['Profile', r.tables.profiles_cloud],
                    ['Proxy', r.tables.proxies_cloud],
                    ['Khoá mã hoá tài khoản', r.tables.account_secrets],
                    ['Nhóm', r.tables.teams]
                  ].map(([label, t]) =>
                    t ? (
                      <tr key={label as string}>
                        <td style={{ padding: '3px 0' }}>{label as string}</td>
                        <td style={{ textAlign: 'right' }}>
                          {(t as { match: number }).match}/{(t as { cloud: number }).cloud} khớp
                          {(t as { pending: number }).pending ? ` · ${(t as { pending: number }).pending} chờ người khác chuyển` : ''}
                        </td>
                      </tr>
                    ) : null
                  )}
                  {r.files && (
                    <>
                      <tr>
                        <td style={{ padding: '3px 0' }}>File (phiên, cookie, mật khẩu)</td>
                        <td style={{ textAlign: 'right' }}>
                          {r.files.verified}/{r.files.cloud} khớp SHA-256 · {(r.files.bytes / 1048576).toFixed(1)} MB
                        </td>
                      </tr>
                      <tr>
                        <td style={{ padding: '3px 0' }}>Két passkey</td>
                        <td style={{ textAlign: 'right' }}>{r.files.passkeyVault ? 'đã chép, khớp từng byte' : 'tài khoản chưa có passkey'}</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
              {r.errors.length > 0 && (
                <pre className="hint" style={{ whiteSpace: 'pre-wrap', color: '#ff9a96', fontSize: 12, maxHeight: 160, overflow: 'auto' }}>
                  {r.errors.join('\n')}
                </pre>
              )}
            </div>
          )}
          {phase === 'done' && fatal && (
            <p style={{ color: '#ff7a76', marginBottom: 0 }}>{fatal}</p>
          )}
          {phase === 'done' && warnings.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="hint">{warnings.length} cảnh báo khi đẩy dữ liệu trên máy</summary>
              <pre className="hint" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{warnings.join('\n')}</pre>
            </details>
          )}
        </div>
        <footer className="modal-foot">
          {phase === 'intro' && (
            <button className="btn primary" disabled={!password} onClick={() => void run()}>
              Bắt đầu chuyển
            </button>
          )}
          {phase === 'done' && (
            <>
              {!status?.ok && (
                <button className="btn" onClick={() => setPhase('intro')}>
                  Thử lại
                </button>
              )}
              <button className="btn primary" onClick={onClose}>
                Đóng
              </button>
            </>
          )}
          {phase === 'running' && <span className="hint">Đang chuyển — đừng tắt app…</span>}
        </footer>
      </div>
    </div>
  )
}
