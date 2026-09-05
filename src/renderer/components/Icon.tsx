// ── VGC Browser — inline SVG icon set (lucide-style, stroke icons) ────────────
// One component, one `name` prop. 24×24 viewBox, currentColor stroke, so icons take the
// text colour of their parent and scale with `size`. No emoji, no icon font, no CSP issue.
import type { CSSProperties } from 'react'

const PATHS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.5-3.5',
  plus: 'M12 5v14 M5 12h14',
  play: 'M7 5.5v13l11-6.5z',
  stop: 'M6 6h12v12H6z',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  'more-v': 'M12 5h.01 M12 12h.01 M12 19h.01',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3a14 14 0 0 1 4 9 14 14 0 0 1-4 9 14 14 0 0 1-4-9 14 14 0 0 1 4-9z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'folder-plus': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 10v6 M9 13h6',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  layers: 'M12 3 3 8l9 5 9-5-9-5z M3 13l9 5 9-5 M3 18l9 5 9-5',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v5h-5',
  download: 'M12 4v11 M7 10l5 5 5-5 M4 19h16',
  upload: 'M12 15V4 M7 9l5-5 5 5 M4 19h16',
  'upload-cloud': 'M8 17a5 5 0 0 1-.9-9.9A7 7 0 0 1 20 9.5a4 4 0 0 1-1 7.9 M12 12v8 M8.5 15.5 12 12l3.5 3.5',
  cloud: 'M8 18a5 5 0 0 1-.9-9.9A7 7 0 0 1 20 10.5 4 4 0 0 1 19 18z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
  calendar: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M4 10h16 M8 2v4 M16 2v4',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z M5 3l.6 1.6L7 5l-1.4.6L5 7l-.6-1.4L3 5l1.4-.4z',
  leaf: 'M5 20c0-8 4-14 14-15-.5 10-6 15-14 15z M5 20c3-4 6-7 10-10',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12 M18 6 6 18',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-up': 'M6 15l6-6 6 6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  key: 'M15 3a6 6 0 0 0-5.7 7.8L3 17v4h4l1-1v-2h2v-2h2l1.2-1.2A6 6 0 1 0 15 3z M16 8h.01',
  copy: 'M9 9h10v11H9z M5 15V4h10',
  edit: 'M4 20h4l11-11-4-4L4 16z M13 6l4 4',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7z',
  monitor: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M8 21h8 M12 16v5',
  laptop: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9H4z M2 18h20l-1 2H3z',
  'log-out': 'M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4 M14 8l4 4-4 4 M18 12H9',
  alert: 'M12 3l10 18H2z M12 10v4 M12 18h.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 8h.01',
  wifi: 'M2 9a15 15 0 0 1 20 0 M5.5 12.5a10 10 0 0 1 13 0 M9 16a5 5 0 0 1 6 0 M12 20h.01',
  fingerprint:
    'M7 20c-1.5-2-2-4-2-6a7 7 0 0 1 14 0c0 1.2-.1 2.4-.4 3.5 M10 20c-.7-1.8-1-3.7-1-6a3 3 0 0 1 6 0c0 2-.2 4-.6 6 M12 14v0 M4 9a9 9 0 0 1 16 0',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M3 7l9 6 9-6',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3 M5 11h14v10H5z',
  'external-link': 'M14 4h6v6 M20 4l-9 9 M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
  dot: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  inbox: 'M4 13l2-8h12l2 8v6H4z M4 13h5l1 2h4l1-2h5',
  tool: 'M14.7 6.3a4 4 0 0 0 5 5l-9 9a2.1 2.1 0 0 1-3-3l9-9a4 4 0 0 0-2-2z M3 21l6-6'
}

export type IconName = keyof typeof PATHS

interface Props {
  name: IconName | string
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
  title?: string
}

export function Icon({ name, size = 18, strokeWidth = 1.9, className, style, title }: Props): JSX.Element {
  const d = PATHS[name] ?? PATHS.dot
  return (
    <svg
      className={`ic${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      style={style}
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  )
}

/** Regional-indicator flag emoji for an ISO-2 country code ('' when unknown). */
export function flagEmoji(cc?: string | null): string {
  const c = (cc || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return ''
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
}

/** "4 phút trước" style relative time from an ISO stamp. */
export function timeAgo(iso?: string): string {
  if (!iso) return 'chưa dùng'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'vừa xong'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'vừa xong'
  if (m < 60) return `${m} phút trước`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} giờ trước`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} ngày trước`
  const mo = Math.floor(d / 30)
  return mo < 12 ? `${mo} tháng trước` : `${Math.floor(mo / 12)} năm trước`
}
