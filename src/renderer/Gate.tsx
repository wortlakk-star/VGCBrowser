import { useEffect, useState } from 'react'
import App from './App'
import { AuthScreen } from './components/AuthScreen'
import { getCloud } from './cloud'
import logo from './assets/logo.png'
import type { Session } from '@supabase/supabase-js'

type Status = 'loading' | 'out' | 'in'

/**
 * Auth gate: the app REQUIRES a logged-in account. Until the user signs in we
 * show <AuthScreen/>; once authenticated we render the full app. This component
 * also owns the single source of truth for the cloud session and pushes it to
 * main (for profile-data sync), keeping it fresh via onAuthStateChange.
 */
export default function Gate(): JSX.Element {
  const [status, setStatus] = useState<Status>('loading')

  useEffect(() => {
    let unsub: (() => void) | undefined
    void (async () => {
      const c = await getCloud()
      if (!c) {
        // Supabase not configured → still gate (AuthScreen shows a message).
        setStatus('out')
        return
      }

      const apply = async (session: Session | null): Promise<void> => {
        if (session) {
          await window.vgc.cloudSetSession({
            accessToken: session.access_token,
            uid: session.user.id
          })
          setStatus('in')
        } else {
          await window.vgc.cloudSetSession(null)
          setStatus('out')
        }
      }

      const { data } = await c.auth.getSession()
      await apply(data.session)

      const { data: sub } = c.auth.onAuthStateChange((_e, session) => {
        void apply(session)
      })
      unsub = () => sub.subscription.unsubscribe()
    })()
    return () => {
      if (unsub) unsub()
    }
  }, [])

  // Called by AuthScreen right after a successful sign-in — guarantees the
  // redirect into the app even if the auth event is slow/missed.
  const handleAuthed = async (): Promise<void> => {
    const c = await getCloud()
    const session = c ? (await c.auth.getSession()).data.session : null
    if (session) {
      await window.vgc.cloudSetSession({
        accessToken: session.access_token,
        uid: session.user.id
      })
    }
    setStatus('in')
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
