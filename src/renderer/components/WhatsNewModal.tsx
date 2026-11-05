// Bảng "Có gì mới": cho nhân viên biết mỗi bản cập nhật sửa lỗi gì, thêm gì, và họ cần làm gì.
// Nguồn: src/shared/changelog.json (đóng gói trong app) hoặc ghi chú phát hành trong latest.yml (bản chưa cài).
import changelog from '../../shared/changelog.json'
import { Icon } from './Icon'

export interface ChangeEntry {
  version: string
  date: string
  fixed: string[]
  added: string[]
  action: string[]
}

export const CHANGELOG: ChangeEntry[] = changelog.entries

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** Các bản mới hơn `seen` tới `current` (mới nhất trước). Chưa từng xem → chỉ bản hiện tại. */
export function entriesSince(seen: string | null, current: string): ChangeEntry[] {
  return CHANGELOG.filter((e) =>
    seen ? cmp(e.version, seen) > 0 && cmp(e.version, current) <= 0 : e.version === current
  ).sort((a, b) => cmp(b.version, a.version))
}

/** Đổi ghi chú phát hành dạng chữ ("Đã sửa lỗi:\n- …") của latest.yml thành một mục. */
export function entryFromNotes(version: string, notes: string): ChangeEntry {
  const e: ChangeEntry = { version, date: '', fixed: [], added: [], action: [] }
  let cur: string[] = e.added
  for (const raw of notes.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^đã sửa/i.test(line)) cur = e.fixed
    else if (/^có gì mới|^cập nhật/i.test(line)) cur = e.added
    else if (/cần làm/i.test(line)) cur = e.action
    else cur.push(line.replace(/^[-*•]\s*/, ''))
  }
  return e
}

const SECTIONS: { key: 'fixed' | 'added' | 'action'; title: string; color: string }[] = [
  { key: 'action', title: 'Nhân viên cần làm', color: 'var(--accent-2)' },
  { key: 'fixed', title: 'Đã sửa lỗi', color: '#e0534f' },
  { key: 'added', title: 'Có gì mới', color: 'var(--green)' }
]

export function WhatsNewModal({
  title,
  entries,
  onClose,
  footer
}: {
  title: string
  entries: ChangeEntry[]
  onClose: () => void
  footer?: React.ReactNode
}): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="sparkles" size={18} style={{ color: 'var(--green)' }} />
            {title}
          </h2>
          <button className="btn" onClick={onClose}>
            <Icon name="x" size={16} strokeWidth={2.4} />
          </button>
        </header>
        <div className="modal-body">
          {entries.length === 0 && <p className="hint" style={{ margin: 0 }}>Chưa có ghi chú cho bản này.</p>}
          {entries.map((e) => (
            <div key={e.version} className="card whatsnew">
              <div className="whatsnew-ver">
                Bản {e.version}
                {e.date && <span className="hint"> · {e.date.split('-').reverse().join('/')}</span>}
              </div>
              {SECTIONS.filter((s) => e[s.key].length).map((s) => (
                <div key={s.key} className="whatsnew-sec">
                  <div className="whatsnew-title" style={{ color: s.color }}>
                    {s.title}
                  </div>
                  <ul>
                    {e[s.key].map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
        <footer className="modal-foot">
          {footer ?? (
            <button className="btn primary" onClick={onClose}>
              Đã hiểu
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
