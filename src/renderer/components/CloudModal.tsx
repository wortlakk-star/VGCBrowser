import { useEffect, useState } from 'react'
import type { Profile } from '../../shared/types'
import { getCloud, pullCloudProfileList, pushCloudProfileList } from '../cloud'

const TEAM_SHARING_ENABLED = false

interface Props {
  onClose: () => void
  onSynced: () => void
}

interface Team {
  id: string
  name: string
}

export function CloudModal({ onClose, onSynced }: Props): JSX.Element {
  const [ready, setReady] = useState<boolean | null>(null) // null=loading, false=not configured
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState<string | null>(null)
  const [uid, setUid] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // teams
  const [teams, setTeams] = useState<Team[]>([])
  const [target, setTarget] = useState('') // '' = personal, else team id
  const [members, setMembers] = useState<string[]>([])
  const [newTeamName, setNewTeamName] = useState('')
  const [memberUid, setMemberUid] = useState('')
  const [localProfiles, setLocalProfiles] = useState<Profile[]>([])

  const assignTeam = async (profileId: string, teamId: string): Promise<void> => {
    await window.vgc.updateProfile(profileId, { cloudTeamId: teamId || undefined })
    setLocalProfiles(await window.vgc.listProfiles())
  }

  const loadTeams = async (): Promise<void> => {
    const c = await getCloud()
    if (!c) return
    const { data } = await c.from('teams').select('id,name')
    setTeams((data ?? []) as Team[])
  }

  const loadAccount = async (): Promise<void> => {
    const c = await getCloud()
    if (!c) return
    const { data } = await c.auth.getUser()
    setUser(data.user?.email ?? null)
    setUid(data.user?.id ?? '')
    // Hand the live access token to main so it can sync profile data to Storage.
    const { data: sess } = await c.auth.getSession()
    if (sess.session && data.user) {
      await window.vgc.cloudSetSession({
        accessToken: sess.session.access_token,
        uid: data.user.id
      })
    }
    if (data.user && TEAM_SHARING_ENABLED) {
      await loadTeams()
      setLocalProfiles(await window.vgc.listProfiles())
    }
  }

  useEffect(() => {
    void (async () => {
      const c = await getCloud()
      if (!c) {
        setReady(false)
        return
      }
      setReady(true)
      await loadAccount()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMembers = async (teamId: string): Promise<void> => {
    const c = await getCloud()
    if (!c || !teamId) {
      setMembers([])
      return
    }
    const { data } = await c.from('team_members').select('user_id').eq('team_id', teamId)
    setMembers(((data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id))
  }

  const onTargetChange = async (value: string): Promise<void> => {
    setTarget(value)
    if (value) await loadMembers(value)
    else setMembers([])
  }

  const signIn = async (): Promise<void> => {
    const c = await getCloud()
    if (!c) return
    setBusy(true)
    setMsg('')
    const { error } = await c.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setMsg('Lỗi: ' + error.message)
    else await loadAccount()
  }

  const signUp = async (): Promise<void> => {
    const c = await getCloud()
    if (!c) return
    setBusy(true)
    setMsg('')
    const { error } = await c.auth.signUp({ email, password })
    setBusy(false)
    setMsg(
      error
        ? 'Lỗi: ' + error.message
        : 'Đã tạo tài khoản. Nếu Supabase bật xác nhận email, hãy xác nhận rồi đăng nhập.'
    )
  }

  const signOut = async (): Promise<void> => {
    const c = await getCloud()
    await c?.auth.signOut()
    await window.vgc.cloudSetSession(null)
    setUser(null)
    setTeams([])
    setTarget('')
  }

  const createTeam = async (): Promise<void> => {
    const c = await getCloud()
    if (!c || !newTeamName.trim()) return
    setBusy(true)
    setMsg('')
    try {
      const { data, error } = await c
        .from('teams')
        .insert({ name: newTeamName.trim() })
        .select('id,name')
        .single()
      if (error || !data) {
        setMsg('Lỗi: ' + (error?.message ?? 'tạo nhóm thất bại'))
        return
      }
      await c.from('team_members').insert({ team_id: data.id, user_id: uid, role: 'owner' })
      setNewTeamName('')
      await loadTeams()
      await onTargetChange(data.id as string)
      setMsg(`Đã tạo nhóm "${data.name}".`)
    } finally {
      setBusy(false)
    }
  }

  const addMember = async (): Promise<void> => {
    const c = await getCloud()
    if (!c || !target || !memberUid.trim()) return
    setBusy(true)
    setMsg('')
    const { error } = await c
      .from('team_members')
      .insert({ team_id: target, user_id: memberUid.trim(), role: 'member' })
    setBusy(false)
    if (error) setMsg('Lỗi: ' + error.message)
    else {
      setMemberUid('')
      await loadMembers(target)
      setMsg('Đã thêm thành viên.')
    }
  }

  const push = async (): Promise<void> => {
    const c = await getCloud()
    if (!c) return
    setBusy(true)
    setMsg('')
    try {
      if (!uid) {
        setMsg('Chưa đăng nhập')
        return
      }
      const encryption = await window.vgc.cloudEncryptionStatus()
      if (!encryption.configured || !encryption.unlocked) {
        setMsg('Lỗi: cần mở khoá mã hoá Cloud trong Cài đặt trước khi đồng bộ.')
        return
      }
      const locals = await window.vgc.listProfiles()
      // 1) Upload each profile's browser DATA (cookies/logins/storage) to Storage.
      //    This sets cloudDataAt on the profile so "pull" knows to fetch it.
      for (let i = 0; i < locals.length; i++) {
        setMsg(`Đang đẩy dữ liệu phiên ${i + 1}/${locals.length}…`)
        try {
          await window.vgc.cloudUploadData(locals[i].id)
        } catch {
          // profile may have never been opened (no data yet) — metadata still syncs
        }
      }
      // 2) Use the same encrypted metadata pipeline as automatic sync.
      const count = await pushCloudProfileList(true)
      setMsg(`Đã đẩy ${count} profile (kèm dữ liệu phiên đăng nhập) lên cloud.`)
    } catch (error) {
      setMsg(`Lỗi: ${error instanceof Error ? error.message : 'đồng bộ thất bại'}`)
    } finally {
      setBusy(false)
    }
  }

  const pull = async (): Promise<void> => {
    const c = await getCloud()
    if (!c) return
    setBusy(true)
    setMsg('')
    try {
      const encryption = await window.vgc.cloudEncryptionStatus()
      if (!encryption.configured || !encryption.unlocked) {
        setMsg('Lỗi: cần mở khoá mã hoá Cloud trong Cài đặt trước khi đồng bộ.')
        return
      }
      const count = await pullCloudProfileList()
      const profiles = await window.vgc.listProfiles()
      // Download the browser DATA for every profile that has it in the cloud,
      // so each opens already signed into its sites on this machine.
      let got = 0
      const withData = profiles.filter((p) => p.cloudDataAt)
      for (let i = 0; i < withData.length; i++) {
        setMsg(`Đang kéo dữ liệu phiên ${i + 1}/${withData.length}…`)
        try {
          if (await window.vgc.cloudDownloadData(withData[i].id)) got++
        } catch {
          // continue with the rest
        }
      }
      setMsg(`Đã kéo ${count} profile về máy (kèm dữ liệu đăng nhập của ${got} profile).`)
      onSynced()
    } catch (error) {
      setMsg(`Lỗi: ${error instanceof Error ? error.message : 'đồng bộ thất bại'}`)
    } finally {
      setBusy(false)
    }
  }

  const copyUid = (): void => {
    void navigator.clipboard?.writeText(uid).catch(() => {})
    setMsg('Đã copy User ID.')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 560 }}>
        <header className="modal-head">
          <h2>☁ Cloud</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {ready === null ? (
            <div className="empty">Đang tải…</div>
          ) : ready === false ? (
            <section className="card">
              <h3>Chưa cấu hình Supabase</h3>
              <p className="hint">
                Mở <b>⚙ Cài đặt → Cloud</b>, dán <b>Project URL</b> + <b>anon key</b>, và chạy{' '}
                <code>supabase/schema.sql</code> trong SQL Editor của project.
              </p>
            </section>
          ) : !user ? (
            <section className="card">
              <h3>Đăng nhập</h3>
              <label>
                Email
                <input value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label>
                Mật khẩu
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <div className="proxy-check">
                <button className="btn primary" onClick={signIn} disabled={busy}>
                  Đăng nhập
                </button>
                <button className="btn" onClick={signUp} disabled={busy}>
                  Tạo tài khoản
                </button>
              </div>
            </section>
          ) : (
            <>
              <section className="card">
                <div className="card-head">
                  <h3>Tài khoản: {user}</h3>
                  <button className="btn ghost" onClick={signOut} disabled={busy}>
                    Đăng xuất
                  </button>
                </div>
                <label>
                  User ID
                  <div className="token-row">
                    <input className="mono small" value={uid} readOnly />
                    <button className="btn" onClick={copyUid}>
                      Copy
                    </button>
                  </div>
                </label>
              </section>

              <section className="card">
                <h3>Đồng bộ</h3>
                {TEAM_SHARING_ENABLED && (
                  <label>
                    Đẩy lên
                    <select value={target} onChange={(e) => void onTargetChange(e.target.value)}>
                      <option value="">Cá nhân</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          Nhóm: {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="proxy-check">
                  <button className="btn primary" onClick={push} disabled={busy}>
                    ↥ Đẩy lên (kèm phiên)
                  </button>
                  <button className="btn" onClick={pull} disabled={busy}>
                    ↧ Kéo về (kèm phiên)
                  </button>
                </div>
                <p className="hint">
                  <b>Dữ liệu phiên đồng bộ TỰ ĐỘNG</b> khi đã đăng nhập: mở profile → tự kéo
                  bản mới nhất từ cloud về; đóng profile / tắt app → tự đẩy phiên mới lên (trước
                  khi thoát). Không cần bấm tay.
                  <br />
                  Hai nút dưới chỉ dùng để đồng bộ <b>danh sách profile</b> sang máy mới
                  (<b>Kéo về</b> lần đầu) hoặc đẩy/kéo tất cả ngay lập tức.
                </p>
              </section>

              {TEAM_SHARING_ENABLED && (
                <section className="card">
                  <h3>Nhóm (Team)</h3>
                  <div className="token-row">
                    <input
                      placeholder="Tên nhóm mới"
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                    />
                    <button className="btn" onClick={createTeam} disabled={busy}>
                      Tạo nhóm
                    </button>
                  </div>
                  {target ? (
                    <>
                      <p className="hint">
                        Thành viên nhóm “{teams.find((t) => t.id === target)?.name}”:{' '}
                        {members.length}
                      </p>
                      <ul className="ext-list">
                        {members.map((m) => (
                          <li key={m}>
                            <span className="mono small">{m}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="token-row">
                        <input
                          placeholder="User ID thành viên cần thêm"
                          value={memberUid}
                          onChange={(e) => setMemberUid(e.target.value)}
                        />
                        <button className="btn" onClick={addMember} disabled={busy}>
                          Thêm thành viên
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="hint">Chọn một nhóm ở mục “Đẩy lên” để quản lý thành viên.</p>
                  )}
                </section>
              )}

              {TEAM_SHARING_ENABLED && teams.length > 0 && localProfiles.length > 0 && (
                <section className="card">
                  <h3>Gán nhóm theo profile</h3>
                  <ul className="ext-list" style={{ maxHeight: 200, overflow: 'auto' }}>
                    {localProfiles.map((p) => (
                      <li key={p.id}>
                        <span style={{ flex: 1 }}>{p.name}</span>
                        <select
                          value={p.cloudTeamId ?? ''}
                          onChange={(e) => void assignTeam(p.id, e.target.value)}
                        >
                          <option value="">Cá nhân</option>
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </li>
                    ))}
                  </ul>
                  <p className="hint">Lần “Đẩy lên” tiếp theo, mỗi profile vào đúng nhóm đã gán.</p>
                </section>
              )}
            </>
          )}

          {msg && (
            <p
              className="hint"
              style={{ color: msg.startsWith('Lỗi') ? 'var(--red)' : 'var(--green)' }}
            >
              {msg}
            </p>
          )}
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
