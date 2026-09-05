// ── VGC Browser — CDP fingerprint injector ───────────────────────────────────
// Connects to a freshly-spawned Chromium over CDP and, for every page/iframe
// target (including ones the user opens later), applies the profile fingerprint:
//
//   • Network.setUserAgentOverride  → UA + Accept-Language + Client Hints (native)
//   • Emulation.setTimezoneOverride → timezone (native, undetectable)
//   • Emulation.setLocaleOverride   → locale
//   • Emulation.setGeolocationOverride → geo (if set)
// Fingerprint readbacks are handled by VGC Core's native patches. This controller never
// injects page JavaScript, avoiding a detectable second spoofing layer. It returns a handle
// to open URLs and dispose the session.

import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from './cdp'
import type { Cookie, Fingerprint, Profile } from '../shared/types'

export interface InjectorHandle {
  openUrl: (url: string) => Promise<void>
  getCookies: () => Promise<Cookie[]>
  /** URLs of the currently-open page tabs (via CDP, no HTTP /json endpoint). */
  getOpenTabs: () => Promise<string[]>
  /** Ask the browser to shut down GRACEFULLY over CDP (flushes cookies/storage). Resolves once
   *  the request was sent or the connection is gone; the caller escalates on a timer. */
  close: () => Promise<void>
  dispose: () => void
}

/** Dedupe cookies by name+domain+path; LATER entries win (synced cookies are
 *  appended after the profile's imported ones, so the freshest session wins). */
function dedupeCookies(cookies: Cookie[]): Cookie[] {
  const byKey = new Map<string, Cookie>()
  for (const c of cookies) byKey.set(`${c.name}\x00${c.domain}\x00${c.path ?? '/'}`, c)
  return [...byKey.values()]
}

/** Derive Client Hints platform fields from the fingerprint's platform/UA. */
function chPlatform(fp: Fingerprint): {
  platform: string
  architecture: string
  bitness: string
  mobile: boolean
  model: string
} {
  const ua = fp.userAgent
  if (fp.platform === 'MacIntel' || ua.includes('Mac OS X')) {
    return { platform: 'macOS', architecture: 'arm', bitness: '64', mobile: false, model: '' }
  }
  if (ua.includes('Android')) {
    return { platform: 'Android', architecture: '', bitness: '', mobile: true, model: 'Pixel 7' }
  }
  if (fp.platform.includes('Linux')) {
    return { platform: 'Linux', architecture: 'x86', bitness: '64', mobile: false, model: '' }
  }
  return { platform: 'Windows', architecture: 'x86', bitness: '64', mobile: false, model: '' }
}

function buildUaMetadata(fp: Fingerprint): Record<string, unknown> {
  const major = fp.uaFullVersion.split('.')[0] || '126'
  const ch = chPlatform(fp)
  return {
    brands: [
      { brand: 'Not/A)Brand', version: '8' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major }
    ],
    fullVersionList: [
      { brand: 'Not/A)Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version: fp.uaFullVersion },
      { brand: 'Google Chrome', version: fp.uaFullVersion }
    ],
    platform: ch.platform,
    platformVersion: fp.uaPlatformVersion,
    architecture: ch.architecture,
    model: ch.model,
    mobile: ch.mobile,
    bitness: ch.bitness,
    wow64: false,
    fullVersion: fp.uaFullVersion
  }
}

export async function attachInjector(
  profile: Profile,
  pipe: { write: Writable; read: Readable },
  opts: { seedCookies?: Cookie[] } = {}
): Promise<InjectorHandle> {
  const conn = CdpConnection.connectPipe(pipe.write, pipe.read)
  const fp = profile.fingerprint
  // Cookies to seed before any navigation: the profile's imported cookies PLUS the
  // plaintext cookies synced from another machine (cross-machine login persistence,
  // bypassing the machine-bound Cookies DB encryption). Deduped by name+domain+path,
  // synced cookies winning (they're the freshest session).
  const seedCookies = dedupeCookies([...(profile.cookies ?? []), ...(opts.seedCookies ?? [])])
  const isMobile = fp.userAgent.includes('Mobile') || fp.platform.includes('armv')
  let cookiesApplied = false

  const setupTarget = async (sessionId: string): Promise<void> => {
    try {
      await conn.send('Page.enable', {}, sessionId)
      // NOTE: deliberately NOT calling Runtime.enable — it's the #1 CDP automation
      // tell (Google "this browser may not be secure", CreepJS, etc. detect it).
      // Targets start paused (waitForDebuggerOnStart), so protocol overrides are in
      // place before page code runs without enabling the Runtime domain.
      await conn.send('Network.enable', {}, sessionId)

      // Re-arm auto-attach ON THIS SESSION so cross-origin (OOPIF) iframes and workers that
      // belong to this page surface as child targets. flatten routes child sessions back
      // through the same Target.attachedToTarget handler for consistent protocol overrides.
      try {
        await conn.send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          sessionId
        )
      } catch {
        // older builds: browser-level auto-attach still covers same-process frames
      }

      // Seed imported + cross-machine-synced cookies once, before any navigation.
      if (!cookiesApplied && seedCookies.length > 0) {
        cookiesApplied = true
        try {
          await conn.send(
            'Network.setCookies',
            {
              cookies: seedCookies.map((c) => {
                // CDP needs a `url` (or it silently drops Secure / SameSite=None
                // cookies). Derive one from the domain so cross-machine login
                // cookies actually restore. Leading-dot domains → strip the dot.
                const host = (c.domain ?? '').replace(/^\./, '')
                const scheme = c.secure ? 'https' : 'http'
                return {
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  url: host ? `${scheme}://${host}${c.path ?? '/'}` : undefined,
                  path: c.path ?? '/',
                  secure: c.secure,
                  httpOnly: c.httpOnly,
                  sameSite: c.sameSite,
                  expires: c.expires
                }
              })
            },
            sessionId
          )
        } catch {
          // ignore cookie failures
        }
      }

      // Each override is wrapped on its own so one failure can't skip the rest (or, now
      // that the script is already installed above, unspoof the page).
      try {
        await conn.send(
          'Network.setUserAgentOverride',
          {
            userAgent: fp.userAgent,
            // Real Chrome sends q-values: "en-US,en;q=0.9". A q-less multi-language header
            // is not a shape Chrome emits, and Cloudflare/creepjs compare it to
            // navigator.languages. Build the weighted list here.
            acceptLanguage: fp.languages
              .map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
              .join(','),
            platform: fp.platform,
            userAgentMetadata: buildUaMetadata(fp)
          },
          sessionId
        )
      } catch {
        // Launch flags and native VGC patches remain the fail-safe identity.
      }

      try {
        await conn.send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone }, sessionId)
      } catch {
        // bad/unsupported timezone id — leave the host zone rather than abort
      }

      try {
        await conn.send('Emulation.setLocaleOverride', { locale: fp.language }, sessionId)
      } catch {
        // not all builds support locale override
      }

      if (fp.geolocation) {
        try {
          await conn.send(
            'Emulation.setGeolocationOverride',
            {
              latitude: fp.geolocation.latitude,
              longitude: fp.geolocation.longitude,
              accuracy: fp.geolocation.accuracy
            },
            sessionId
          )
        } catch {
          // ignore
        }
      }

      // Mobile profiles: emulate device metrics + touch input.
      if (isMobile) {
        try {
          await conn.send(
            'Emulation.setDeviceMetricsOverride',
            {
              width: fp.screen.width,
              height: fp.screen.height,
              deviceScaleFactor: fp.devicePixelRatio,
              mobile: true
            },
            sessionId
          )
          await conn.send(
            'Emulation.setTouchEmulationEnabled',
            { enabled: true, maxTouchPoints: 5 },
            sessionId
          )
        } catch {
          // ignore
        }
      }

      // No Runtime.evaluate or page script is used. Real pages start paused while these
      // protocol settings are applied; VGC Core supplies the native fingerprint surfaces.
    } catch {
      // per-target failures shouldn't kill the whole session
    } finally {
      // Release the target if it was paused waiting for the debugger.
      try {
        await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      } catch {
        // ignore
      }
    }
  }

  conn.on('Target.attachedToTarget', (params) => {
    const sessionId = params.sessionId as string
    const targetInfo = params.targetInfo as { type?: string } | undefined
    if (targetInfo && (targetInfo.type === 'page' || targetInfo.type === 'iframe')) {
      void setupTarget(sessionId)
    } else {
      conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
    }
  })

  // Auto-attach to all current and future targets; flatten => sessionId routing.
  await conn.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true
  })

  // Attach to the initial page that already exists at launch.
  try {
    const { targetInfos } = (await conn.send('Target.getTargets')) as {
      targetInfos?: Array<{ targetId: string; type: string }>
    }
    for (const t of targetInfos ?? []) {
      if (t.type === 'page') {
        await conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
      }
    }
  } catch {
    // ignore
  }

  return {
    openUrl: async (url: string) => {
      await conn.send('Target.createTarget', { url })
    },
    getOpenTabs: async (): Promise<string[]> => {
      try {
        const { targetInfos } = (await conn.send('Target.getTargets')) as {
          targetInfos?: Array<{ type: string; url: string }>
        }
        return (targetInfos ?? [])
          .filter(
            (t) =>
              t.type === 'page' &&
              t.url &&
              !t.url.startsWith('devtools://') &&
              t.url !== 'about:blank'
          )
          .map((t) => t.url)
      } catch {
        return []
      }
    },
    getCookies: async (): Promise<Cookie[]> => {
      try {
        const r = (await conn.send('Storage.getCookies')) as {
          cookies?: Array<Record<string, unknown>>
        }
        return (r.cookies ?? []).map((c) => ({
          name: String(c.name ?? ''),
          value: String(c.value ?? ''),
          domain: String(c.domain ?? ''),
          path: typeof c.path === 'string' ? c.path : '/',
          expires: typeof c.expires === 'number' ? c.expires : undefined,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite:
            c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None'
              ? c.sameSite
              : undefined
        }))
      } catch {
        return []
      }
    },
    close: async () => {
      await Promise.race([
        conn.send('Browser.close').catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 5000))
      ])
    },
    dispose: () => conn.close()
  }
}
