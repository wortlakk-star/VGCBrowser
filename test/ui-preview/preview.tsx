// Renderer preview entry: installs the mock bridge, applies the theme from the URL
// (?theme=light|dark) and renders the requested screen (?screen=app|auth).
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createMockVgc } from './mock-vgc'
import '../../src/renderer/styles.css'

;(window as unknown as { vgc: unknown }).vgc = createMockVgc()

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.setAttribute('data-theme', theme)
localStorage.setItem('vgc-theme', theme)

async function main(): Promise<void> {
  const screen = params.get('screen') ?? 'app'
  const root = createRoot(document.getElementById('root')!)
  if (screen === 'auth') {
    const { AuthScreen } = await import('../../src/renderer/components/AuthScreen')
    root.render(<AuthScreen onAuthed={async () => undefined} />)
    return
  }
  const { default: App } = await import('../../src/renderer/App')
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void main()
