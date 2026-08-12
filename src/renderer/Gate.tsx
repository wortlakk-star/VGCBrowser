import { useEffect, useRef, useState } from 'react'
import App from './App'
import { AuthScreen } from './components/AuthScreen'
import { getCloud } from './cloud'
import logo from './assets/logo.png'
import type { Session } from '@supabase/supabase-js'

type Status = 'loading' | 'out' | 'in'

interface Gate {
  blocked: boolean
  current: string
  min: string
  downloadUrl: string
}

/**
 * Auth gate: the app REQUIRES a logged-in account. Until the user signs in we
 * show <AuthScreen/>; once authenticated we render the full app. This component
 * also owns the single source of truth for the cloud session and pushes it to
 * main (for profile-data sync), keeping it fresh via onAuthStateChange.
 *
 * BEFORE auth, a forced-update gate runs: if this build is older than the server's
 * minVersion, everything is blocked with a "must update" screen (see version-gate.ts).
 */
export default function Gate(): JSX.Element {
  const [status, setStatus] = useState<Status>('loading')
  const [gate, setGate] = useState<Gate | null>(null)
  const sessionRevision = useRef(0)

  const applySession = async (session: Session | null): Promise<void> => {
    const revision = ++sessionRevision.current
    try {
      const applied = await window.vgc.cloudSetSession(
        session ? { accessToken: session.access_token, uid: session.user.id } : null
      )
      if (applied && revision === sessionRevision.current) setStatus(session ? 'in' : 'out')
    } catch (error) {
      if (revision === sessionRevision.current) setStatus('out')
      throw error
    }
  }

  // Forced-update check first — if blocked, we never reach auth/app.
  useEffect(() => {
    void (async () => {
      try {
        const g = await window.vgc.versionGate()
        if (g?.blocked) setGate(g)
      } catch {
        /* fail-open: don't block on error */
      }
    })()
  }, [])

  useEffect(() => {
    let unsub: (() => void) | undefined
    void (async () => {
      const c = await getCloud()
      if (!c) {
        // Supabase not configured → still gate (AuthScreen shows a message).
        setStatus('out')
        return
      }

      const { data } = await c.auth.getSession()
      try {
        await applySession(data.session)
      } catch (error) {
        console.error('[cloud-session]', error)
      }

      const { data: sub } = c.auth.onAuthStateChange((_e, session) => {
        void applySession(session).catch((error) =>
          console.error('[cloud-session-refresh]', error)
        )
      })
      unsub = () => sub.subscription.unsubscribe()
    })()
    return () => {
      sessionRevision.current++
      if (unsub) unsub()
    }
  }, [])

  // Called by AuthScreen right after a successful sign-in — guarantees the
  // redirect into the app even if the auth event is slow/missed.
  const handleAuthed = async (): Promise<void> => {
    const c = await getCloud()
    const session = c ? (await c.auth.getSession()).data.session : null
    if (session) await applySession(session)
  }

  // Forced update — blocks everything (takes priority over auth/loading).
  if (gate?.blocked) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--fg, #eef0f7)',
          padding: 20
        }}
      >
        <div
          style={{
            maxWidth: 460,
            width: '96%',
            textAlign: 'center',
            background: 'linear-gradient(180deg,#0e1120,#0a0c16)',
            border: '1px solid #2bd6c2',
            borderRadius: 18,
            padding: 34,
            boxShadow: '0 30px 80px rgba(0,0,0,.6)'
          }}
        >
          <img src={logo} alt="VGC" style={{ width: 60, height: 60 }} />
          <h2 style={{ margin: '16px 0 6px', fontSize: 21 }}>Cần cập nhật VGC Browser</h2>
          <p style={{ margin: '0 0 8px', color: 'var(--dim,#9aa3bd)', fontSize: 14, lineHeight: 1.6 }}>
            Phiên bản của bạn ({gate.current}) đã cũ và không còn được hỗ trợ. Vui lòng tải bản
            mới nhất ({gate.min} trở lên) để tiếp tục sử dụng.
          </p>
          <button
            onClick={() => void window.vgc.openExternal(gate.downloadUrl)}
            style={{
              marginTop: 16,
              background: '#18c0ad',
              border: 'none',
              color: '#05201c',
              fontWeight: 700,
              borderRadius: 10,
              padding: '12px 22px',
              fontSize: 15,
              cursor: 'pointer'
            }}
          >
            Tải bản mới nhất
          </button>
        </div>
      </div>
    )
  }

  if (status === 'loading') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--dim)'
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <img src={logo} alt="VGC" style={{ width: 56, height: 56 }} />
          <p style={{ marginTop: 8 }}>Đang tải…</p>
        </div>
      </div>
    )
  }

  return status === 'in' ? <App /> : <AuthScreen onAuthed={handleAuthed} />
}
