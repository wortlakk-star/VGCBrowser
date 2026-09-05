// A small click-to-open menu (toolbar "Công cụ", "Nhập / Xuất"). Closes on outside click,
// Escape, scroll and resize. Items are plain buttons so existing handlers plug straight in.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

interface Props {
  label: ReactNode
  icon?: string
  className?: string
  align?: 'left' | 'right'
  children: (close: () => void) => ReactNode
}

export function Dropdown({ label, icon, className, align = 'right', children }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])
  return (
    <div className="dd" ref={ref}>
      <button className={`btn ${className ?? ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {icon && <Icon name={icon} size={16} />}
        {label}
        <Icon name="chevron-down" size={14} style={{ opacity: 0.7 }} />
      </button>
      {open && (
        <div className="dd-menu" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
