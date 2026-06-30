import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * App-wide safety net. WITHOUT this, any uncaught error while React renders (e.g. a
 * malformed profile with a missing fingerprint/proxy field) unmounts the whole tree →
 * the window shows a pure BLANK screen with no clue why. With it, the user sees a
 * readable error + a Reload button instead, and the message is screenshot-able for
 * support. The real data is also self-healed in the main process (store.normalizeProfiles).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: unknown): void {
    // Surfaces in the main process log too (helps remote debugging on customer VPS).
    console.error('[vgc] renderer crashed:', error)
  }

  private reload = (): void => {
    this.setState({ error: null })
    location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        style={{
          padding: 40,
          minHeight: '100vh',
          boxSizing: 'border-box',
          fontFamily: 'system-ui, Segoe UI, sans-serif',
          color: '#e6e6e6',
          background: '#0c1613'
        }}
      >
        <h2 style={{ marginTop: 0 }}>⚠ Giao diện gặp lỗi</h2>
        <p style={{ opacity: 0.85 }}>
          Ứng dụng gặp lỗi khi hiển thị. Bấm “Tải lại” để thử lại. Nếu vẫn lỗi, chụp màn hình
          phần bên dưới gửi hỗ trợ.
        </p>
        <button
          onClick={this.reload}
          style={{ padding: '8px 18px', marginBottom: 18, cursor: 'pointer', fontSize: 14 }}
        >
          ↻ Tải lại
        </button>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            opacity: 0.75,
            maxHeight: 320,
            overflow: 'auto',
            background: 'rgba(0,0,0,.3)',
            padding: 12,
            borderRadius: 6
          }}
        >
          {String(error.stack || error.message || error)}
        </pre>
      </div>
    )
  }
}
