import React from 'react'
import { createRoot } from 'react-dom/client'
import Gate from './Gate'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'
import { applyTheme, getTheme } from './theme'

// Apply saved theme before first paint to avoid a flash.
applyTheme(getTheme())

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Gate />
    </ErrorBoundary>
  </React.StrictMode>
)
