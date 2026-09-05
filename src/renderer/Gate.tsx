import { useCallback, useEffect, useRef, useState } from 'react'
import App from './App'
import { AuthScreen } from './components/AuthScreen'
import { AccessDenied } from './components/AccessDenied'
import { getCloud, signOutEverywhere } from './cloud'
import logo from './assets/logo.png'
import type { Session } from '@supabase/supabase-js'
import type { LicenseCheckResult } from '../shared/types'

type Status = 'loading' | 'out' | 'denied' | 'in'

interface Gate {
  blocked: boolean
  current: string
  min: string
  downloadUrl: string
}

/** How often an open app re-confirms the email is still on the internal list. */
const RECHECK_EVERY_MS = 10 * 60 * 1000
/** A window focus re-checks too, but not more often than this. */
const FOCUS_RECHECK_MIN_MS = 60 * 1000

/**
 * Auth gate: the app REQUIRES a logged-in account AND that account's email must be on
 * the internal list the admin manages at vgcbrowser.com/quanly. Until the user signs
 * in we show <AuthScreen/>; a signed-in but unapproved email gets <AccessDenied/>;
 * only an approved email reaches the full app. This component also owns the single
 * source of truth for the cloud session and pushes it to main (for profile-data
 * sync), keeping it fresh via onAuthStateChange.
 *
 * BEFORE auth, a forced-update gate runs: if this build is older than the server's
 * minVersion, everything is blocked with a "must update" screen (see version-gate.ts).
 */
export default function Gate(): JSX.Element {
  const [status, setStatus] = useState<Status>('loading')
  const [gate, setGate] = useState<Gate | null>(null)
  const [license, setLicense] = useState<LicenseCheckResult | null>(null)
  const sessionRevision = useRef(0)
  const lastRecheckAt = useRef(0)

  const applySession = async (session: Session | null): Promise<void> => {
    const revision = ++sessionRevision.current
    try {
      const applied = await window.vgc.cloudSetSession(
        session ? { accessToken: session.access_token, uid: session.user.id } : null
      )
      if (!applied || revision !== sessionRevision.current) return
      if (!session) {
        setLicense(null)
        setStatus('out')
        return
      }
      // Main derives the email from the token it just validated — the renderer never
      // tells it which email to check — and returns the verdict for THIS check.
      const lic = await window.vgc.licenseCheck()
      if (revision !== sessionRevision.current) return
      lastRecheckAt.current = Date.now()
      setLicense(lic)
      setStatus((prev) => {
        if (lic.approved) return 'in'
        // Already inside (this is a token refresh): only main's revoke decision throws
        // the user out — a single unreachable-server result must not.
        if (prev === 'in' && !lic.revoke) return 'in'
        return 'denied'
      })
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

  // While inside the app, re-confirm the approval periodically and on window focus so
  // an admin revoke takes effect within minutes (main also closes running profiles).
  const recheckWhileIn = useCallback(async (): Promise<void> => {
    const revision = sessionRevision.current
    let lic: LicenseCheckResult
    try {
      lic = await window.vgc.licenseCheck()
    } catch {
      return // could not ask → keep working; the next tick tries again
    }
    if (revision !== sessionRevision.current) return
    lastRecheckAt.current = Date.now()
    if (lic.revoke) {
      setLicense(lic)
      setStatus('denied')
    }
  }, [])

  useEffect(() => {
    if (status !== 'in') return
    const timer = setInterval(() => void recheckWhileIn(), RECHECK_EVERY_MS)
    const onFocus = (): void => {
      if (Date.now() - lastRecheckAt.current >= FOCUS_RECHECK_MIN_MS) void recheckWhileIn()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [status, recheckWhileIn])

  // Called by AuthScreen right after a successful sign-in — guarantees the
  // redirect into the app even if the auth event is slow/missed.
  const handleAuthed = async (): Promise<void> => {
    const c = await getCloud()
    const session = c ? (await c.auth.getSession()).data.session : null
    if (session) await applySession(session)
  }

  // "Kiểm tra lại" on the denied screen: same check, same session. Returns the fresh
  // verdict so the screen can word its feedback by reason.
  const handleRecheck = async (): Promise<LicenseCheckResult | null> => {
    const revision = sessionRevision.current
    const lic = await window.vgc.licenseCheck()
    if (revision !== sessionRevision.current) return null
    lastRecheckAt.current = Date.now()
    setLicense(lic)
    if (lic.approved) setStatus('in')
    return lic
  }

  const handleSignOut = async (): Promise<void> => {
    await signOutEverywhere(await getCloud())
    await applySession(null).catch(() => setStatus('out'))
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

  if (status === 'in') return <App />
  if (status === 'denied') {
    return <AccessDenied license={license} onRecheck={handleRecheck} onSignOut={handleSignOut} />
  }
  return <AuthScreen onAuthed={handleAuthed} />
}
