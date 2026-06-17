// ── VGC Browser — CDP fingerprint injector ───────────────────────────────────
// Connects to a freshly-spawned Chromium over CDP and, for every page/iframe
// target (including ones the user opens later), applies the profile fingerprint:
//
//   • Network.setUserAgentOverride  → UA + Accept-Language + Client Hints (native)
//   • Emulation.setTimezoneOverride → timezone (native, undetectable)
//   • Emulation.setLocaleOverride   → locale
//   • Emulation.setGeolocationOverride → geo (if set)
//   • Page.addScriptToEvaluateOnNewDocument → JS stealth (canvas/webgl/audio/...)
//
// The first three are real engine-level overrides — the JS layer only covers what
// CDP can't yet reach. Returns a handle to open URLs and to dispose the session.

import { CdpConnection, getBrowserWsUrl } from './cdp'
import { buildStealthScript, seedFromString } from './fingerprint-script'
import type { Cookie, Fingerprint, Profile } from '../shared/types'

export interface InjectorHandle {
  openUrl: (url: string) => Promise<void>
  getCookies: () => Promise<Cookie[]>
  dispose: () => void
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
  port: number
): Promise<InjectorHandle> {
  const wsUrl = await getBrowserWsUrl(port)
  const conn = await CdpConnection.connect(wsUrl)
  const fp = profile.fingerprint
  const script = buildStealthScript(fp, seedFromString(profile.id))
  const isMobile = fp.userAgent.includes('Mobile') || fp.platform.includes('armv')
  let cookiesApplied = false

  const setupTarget = async (sessionId: string): Promise<void> => {
    try {
      await conn.send('Page.enable', {}, sessionId)
      await conn.send('Runtime.enable', {}, sessionId)
      await conn.send('Network.enable', {}, sessionId)

      // Seed imported cookies once, before any navigation.
      if (!cookiesApplied && profile.cookies && profile.cookies.length > 0) {
        cookiesApplied = true
        try {
          await conn.send(
            'Network.setCookies',
            {
              cookies: profile.cookies.map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path ?? '/',
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite: c.sameSite,
                expires: c.expires
              }))
            },
            sessionId
          )
        } catch {
          // ignore cookie failures
        }
      }

      await conn.send(
        'Network.setUserAgentOverride',
        {
          userAgent: fp.userAgent,
          acceptLanguage: fp.languages.join(','),
          platform: fp.platform,
          userAgentMetadata: buildUaMetadata(fp)
        },
        sessionId
      )

      await conn.send(
        'Emulation.setTimezoneOverride',
        { timezoneId: fp.timezone },
        sessionId
      )

      try {
        await conn.send('Emulation.setLocaleOverride', { locale: fp.language }, sessionId)
      } catch {
        // not all builds support locale override
      }

      if (fp.geolocation) {
        await conn.send(
          'Emulation.setGeolocationOverride',
          {
            latitude: fp.geolocation.latitude,
            longitude: fp.geolocation.longitude,
            accuracy: fp.geolocation.accuracy
          },
          sessionId
        )
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

      await conn.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: script },
        sessionId
      )

      // Best-effort: apply to the already-open document too.
      try {
        await conn.send('Runtime.evaluate', { expression: script }, sessionId)
      } catch {
        // ignore
      }
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
    dispose: () => conn.close()
  }
}
