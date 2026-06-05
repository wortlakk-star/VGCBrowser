// ── VGC Browser — fingerprint generator ──────────────────────────────────────
// Produces a *consistent* random fingerprint per OS. "Consistent" is the point:
// userAgent, Client Hints, WebGL renderer, platform, fonts and screen must all
// look like one real machine of that OS. Detectors (creepjs, pixelscan) flag
// profiles whose parts disagree (e.g. a Windows UA with an Apple GPU).

import type { Fingerprint, OsType } from './types'

// Pinned to the current STABLE Chrome (matches the VGC Core engine build so the
// claimed UA/version can't be caught lying via feature-set checks). All profiles
// claim the same stable version (like real auto-updated Chrome); the DEVICE
// fingerprint is what varies per profile.
const CHROME_BUILDS: Array<{ major: number; full: string }> = [
  { major: 149, full: '149.0.7827.54' }
]

const DESKTOP_SCREENS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 }
]

const MOBILE_SCREENS = [
  { width: 412, height: 915 },
  { width: 393, height: 873 },
  { width: 360, height: 800 }
]

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Denver',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Singapore',
  'Asia/Ho_Chi_Minh'
]

const CORES = [4, 6, 8, 12, 16]
const MEMORY = [4, 8, 16]

interface OsPreset {
  uaParens: string
  uaSuffix: string // "Safari/537.36" or "Mobile Safari/537.36"
  platform: string
  platformVersion: string
  fonts: string[]
  gpus: Array<{ vendor: string; renderer: string }>
  mobile: boolean
}

const WIN_FONTS = [
  'Arial', 'Calibri', 'Cambria', 'Cambria Math', 'Comic Sans MS', 'Consolas',
  'Courier New', 'Georgia', 'Lucida Console', 'Segoe UI', 'Tahoma',
  'Times New Roman', 'Trebuchet MS', 'Verdana'
]
const MAC_FONTS = [
  'Arial', 'Geneva', 'Helvetica', 'Helvetica Neue', 'Lucida Grande', 'Menlo',
  'Monaco', 'Times', 'Times New Roman', 'Verdana', 'Courier', 'Courier New'
]
const LINUX_FONTS = [
  'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif',
  'Ubuntu', 'Noto Sans', 'Noto Serif', 'FreeSans', 'Cantarell'
]
const ANDROID_FONTS = ['Roboto', 'Noto Sans', 'Noto Serif', 'Droid Sans', 'Droid Serif']

const OS_PRESETS: Record<OsType, OsPreset> = {
  windows: {
    uaParens: 'Windows NT 10.0; Win64; x64',
    uaSuffix: 'Safari/537.36',
    platform: 'Win32',
    platformVersion: '15.0.0',
    fonts: WIN_FONTS,
    gpus: [
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
    ],
    mobile: false
  },
  macos: {
    uaParens: 'Macintosh; Intel Mac OS X 10_15_7',
    uaSuffix: 'Safari/537.36',
    platform: 'MacIntel',
    platformVersion: '14.5.0',
    fonts: MAC_FONTS,
    gpus: [
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)' }
    ],
    mobile: false
  },
  linux: {
    uaParens: 'X11; Linux x86_64',
    uaSuffix: 'Safari/537.36',
    platform: 'Linux x86_64',
    platformVersion: '6.5.0',
    fonts: LINUX_FONTS,
    gpus: [
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi), OpenGL 4.6 (Core Profile) Mesa 23.2.1)' }
    ],
    mobile: false
  },
  android: {
    uaParens: 'Linux; Android 14; Pixel 7',
    uaSuffix: 'Mobile Safari/537.36',
    platform: 'Linux armv8l',
    platformVersion: '14.0.0',
    fonts: ANDROID_FONTS,
    gpus: [
      { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)' }
    ],
    mobile: true
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Each profile exposes a slightly different detectable font set so no two
 * "chromes" look identical. Keeps the core OS fonts, randomly drops a few of
 * the rest.
 */
function fontSubset(all: string[]): string[] {
  const core = all.slice(0, 5)
  const rest = all.slice(5).filter(() => Math.random() > 0.22)
  return [...core, ...rest]
}

/** Generate a self-consistent fingerprint for the given OS. */
export function generateFingerprint(os: OsType = 'windows'): Fingerprint {
  const preset = OS_PRESETS[os] ?? OS_PRESETS.windows
  const build = pick(CHROME_BUILDS)
  const gpu = pick(preset.gpus)
  const screen = preset.mobile ? pick(MOBILE_SCREENS) : pick(DESKTOP_SCREENS)
  const timezone = pick(TIMEZONES)

  const userAgent =
    `Mozilla/5.0 (${preset.uaParens}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${build.major}.0.0.0 ${preset.uaSuffix}`

  return {
    userAgent,
    platform: preset.platform,
    language: 'en-US',
    languages: ['en-US', 'en'],
    hardwareConcurrency: preset.mobile ? pick([4, 6, 8]) : pick(CORES),
    deviceMemory: preset.mobile ? pick([4, 6, 8]) : pick(MEMORY),
    vendor: 'Google Inc.',
    screen: {
      ...screen,
      colorDepth: 24,
      pixelDepth: 24
    },
    devicePixelRatio: preset.mobile ? 2.625 : 1,
    webgl: gpu,
    canvasNoise: true,
    audioNoise: true,
    clientRectsNoise: true,
    webrtc: 'proxy',
    timezone,
    uaFullVersion: build.full,
    uaPlatformVersion: preset.platformVersion,
    fonts: fontSubset(preset.fonts),
    doNotTrack: 'unset'
  }
}
