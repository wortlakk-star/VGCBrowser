import { useEffect, useState } from 'react'
import type { WarmSchedule } from '../../shared/types'

interface Props {
  /** Currently-selected profile ids — offered as the set to schedule. */
  selectedIds: string[]
  onClose: () => void
}

export function WarmScheduleModal({ selectedIds, onClose }: Props): JSX.Element {
  const [sch, setSch] = useState<WarmSchedule | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void window.vgc.getWarmSchedule().then(setSch)
  }, [])

  const save = async (): Promise<void> => {
    if (!sch) return
    setSaving(true)
    try {
      const next = await window.vgc.setWarmSchedule(sch)
      setSch(next)
      setMsg('✓ Đã lưu.')
    } finally {
      setSaving(false)
    }
  }

  const fmt = (iso?: string): string => (iso ? new Date(iso).toLocaleString('vi') : 'chưa chạy')
  const nextRun = (s: WarmSchedule): string =>
    !s.enabled
      ? '(đang tắt)'
      : s.lastRun
        ? new Date(Date.parse(s.lastRun) + Math.max(1, s.everyHours) * 3600_000).toLocaleString('vi')
        : 'trong ~5 phút tới'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 470 }}>
        <header className="modal-head">
          <h2>Hẹn giờ tự nuôi acc</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <section className="card">
            {!sch ? (
              <p className="hint">Đang tải…</p>
            ) : (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={sch.enabled}
                    onChange={(e) => setSch({ ...sch, enabled: e.target.checked })}
                    style={{ width: 'auto' }}
                  />
                  <span>Bật tự nuôi (chỉ chạy khi app đang mở)</span>
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                  <label>
                    Chạy mỗi (giờ)
                    <input
                      type="number"
                      min={1}
                      value={sch.everyHours}
                      onChange={(e) => setSch({ ...sch, everyHours: Number(e.target.value) || 12 })}
                    />
                  </label>
                  <label>
                    Mỗi profile (phút)
                    <input
                      type="number"
                      min={1}
                      value={sch.minutes}
                      onChange={(e) => setSch({ ...sch, minutes: Number(e.target.value) || 2 })}
                    />
                  </label>
                </div>
                <p className="hint" style={{ marginTop: 10 }}>
                  Áp dụng cho <b>{sch.profileIds.length}</b> profile.
                  <button
                    className="btn"
                    style={{ marginLeft: 8, padding: '4px 10px', fontSize: 12 }}
                    onClick={() => setSch({ ...sch, profileIds: selectedIds })}
                    disabled={!selectedIds.length}
                  >
                    Dùng {selectedIds.length} profile đang chọn
                  </button>
                </p>
                <p className="hint">
                  Lần cuối: {fmt(sch.lastRun)} · Kế tiếp: {nextRun(sch)}
                </p>
                <p className="hint">⚠️ Nên "Đăng nhập Gmail" cho các profile trước khi bật.</p>
                {msg && (
                  <p className="hint" style={{ color: 'var(--green)' }}>
                    {msg}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Đóng
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving || !sch}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </footer>
      </div>
    </div>
  )
}
