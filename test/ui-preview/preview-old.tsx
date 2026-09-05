// Renders the PREVIOUS renderer (checked out from git into ./old) for before/after shots.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createMockVgc } from './mock-vgc'
import './old/src/renderer/styles.css'
;(window as unknown as { vgc: unknown }).vgc = createMockVgc()
const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.setAttribute('data-theme', theme)
async function main(): Promise<void> {
  const root = createRoot(document.getElementById('root')!)
  if ((params.get('screen') ?? 'app') === 'auth') {
    const { AuthScreen } = await import('./old/src/renderer/components/AuthScreen')
    root.render(<AuthScreen onAuthed={async () => undefined} />)
    return
  }
  const { default: App } = await import('./old/src/renderer/App')
  root.render(<React.StrictMode><App /></React.StrictMode>)
}
void main()
