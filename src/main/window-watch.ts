// ── VGC Browser — đóng cửa sổ cuối cùng = tắt profile (macOS) ──────────────────────
// Trên macOS, bấm X đóng cửa sổ cuối thì trình duyệt của profile vẫn chạy ngầm (Dock còn biểu
// tượng) → profile chưa thật sự tắt: chưa lưu phiên lên máy chủ, chưa nhả khoá, bản công ty chưa
// xoá bản trên máy. Cứ 3 giây hỏi macOS (danh sách cửa sổ của hệ thống — không cần quyền, không
// đụng vào trình duyệt) xem tiến trình engine của mỗi profile còn cửa sổ nào; profile ĐÃ TỪNG có
// cửa sổ mà 2 lần liền không còn (~6 giây) thì tắt như bấm Dừng. Extension VGC Life (lock-ext.ts)
// là đường báo nhanh nhưng không chắc chắn (Chrome tắt service worker ngay khi đóng cửa sổ cuối).
// Windows: Chromium tự thoát khi đóng cửa sổ cuối nên không cần.
import { execFile } from 'child_process'
import { dbg } from './dbg'

const EVERY_MS = 3000
const EMPTY_TICKS_TO_STOP = 2

const JXA = `ObjC.import('CoreGraphics'); ObjC.import('Foundation')
function run(argv) {
  const out = {}
  for (const p of argv) out[p] = 0
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0))
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i)
    const pid = String(w.objectForKey('kCGWindowOwnerPID').js)
    if (!(pid in out) || w.objectForKey('kCGWindowLayer').js !== 0) continue
    const b = w.objectForKey('kCGWindowBounds')
    if (b && b.objectForKey('Height').js > 100) out[pid]++
  }
  return JSON.stringify(out)
}`

function countWindows(pids: number[]): Promise<Record<string, number> | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA, ...pids.map(String)], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve(JSON.parse(String(stdout).trim()) as Record<string, number>)
      } catch {
        resolve(null)
      }
    })
  })
}

interface Watched {
  pid: number
  seenWindow: boolean
  emptyTicks: number
}
const watched = new Map<string, Watched>()
let timer: NodeJS.Timeout | null = null
let busy = false

/** Bắt đầu canh cửa sổ của một profile vừa mở (chỉ macOS, chỉ profile có cửa sổ). */
export function watchProfileWindows(id: string, pid: number | undefined, onAllClosed: (id: string) => void): void {
  if (process.platform !== 'darwin' || !pid) return
  watched.set(id, { pid, seenWindow: false, emptyTicks: 0 })
  if (timer) return
  timer = setInterval(() => {
    if (busy || watched.size === 0) return
    busy = true
    const entries = [...watched.entries()]
    void countWindows(entries.map(([, w]) => w.pid))
      .then((counts) => {
        if (!counts) return
        for (const [pid, n] of Object.entries(counts)) {
          const hit = entries.find(([, w]) => String(w.pid) === pid)
          if (!hit) continue
          const [pid0, w] = [hit[0], hit[1]]
          if (watched.get(pid0) !== w) continue // đã thay bằng lần mở khác
          if (n > 0) {
            w.seenWindow = true
            w.emptyTicks = 0
          } else if (w.seenWindow && ++w.emptyTicks >= EMPTY_TICKS_TO_STOP) {
            watched.delete(pid0)
            dbg(`[life ${pid0}] no windows left -> stopping profile`)
            onAllClosed(pid0)
          }
        }
      })
      .finally(() => {
        busy = false
        if (watched.size === 0 && timer) {
          clearInterval(timer)
          timer = null
        }
      })
  }, EVERY_MS)
  timer.unref()
}

/** Engine của lần mở này đã thoát — chỉ bỏ canh nếu đúng tiến trình đó (không đụng lần mở mới). */
export function unwatchProfileWindows(id: string, pid: number | undefined): void {
  if (watched.get(id)?.pid === pid) watched.delete(id)
}
