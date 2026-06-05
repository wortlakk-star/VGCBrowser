// ── VGC Browser — light/dark theme ───────────────────────────────────────────
export type Theme = 'dark' | 'light'

const KEY = 'vgc-theme'

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem(KEY, theme)
}
