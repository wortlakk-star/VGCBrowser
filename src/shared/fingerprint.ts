// ── VGC Browser — fingerprint generator ──────────────────────────────────────
// Produces a *consistent* random fingerprint per OS. "Consistent" is the point:
// userAgent, Client Hints, WebGL renderer, platform, fonts and screen must all
// look like one real machine of that OS. Detectors (creepjs, pixelscan) flag
// profiles whose parts disagree (e.g. a Windows UA with an Apple GPU).

import type { Fingerprint, OsType } from './types'
import engineRelease from './engine-release.json'

// Pinned to the current STABLE Chrome — MUST match the VGC Core engine build, else the
// claimed UA (say 149) contradicts the engine's UA-CH high-entropy hints (151) and
// anti-bot (Google "browser not secure", Cloudflare) flags the version MISMATCH.
// Exported so the store can bump older profiles' UA to this version. Keep in sync with
// the engine (engine-src/BUILD-WINDOWS-ENGINE.md pins 151.0.7902.0).
export const CHROME_BUILD = {
  major: engineRelease.chromeMajor,
  full: engineRelease.chromeVersion
}
const CHROME_BUILDS: Array<{ major: number; full: string }> = [CHROME_BUILD]

// Physical panel resolutions real Windows/Linux desktops and laptops ship with, weighted by
// how common they are. A profile claims one of these AT THE HOST'S DPR: Chrome reports
// screen.width/height in CSS px = physical / devicePixelRatio, so a 1920×1080 panel is
// 1536×864 on a 125 % laptop and 1280×720 at 150 % — exactly what real machines show.
const WIN_PANELS: Array<[number, number]> = [
  [1920, 1080], [1920, 1080], [1920, 1080], [1920, 1080],
  [2560, 1440], [2560, 1440],
  [1366, 768], [1600, 900], [1680, 1050], [1920, 1200], [2560, 1080],
  [3440, 1440], [3840, 2160], [2560, 1600], [1440, 900]
]
// macOS at a Retina (2×) scale: the CSS sizes the stock "default" scaled modes give —
// MacBook Air 13/15, MacBook Pro 14/16, iMac 24, Studio Display, 4K/5K externals.
const MAC_RETINA_SCREENS: Array<[number, number]> = [
  [1440, 900], [1440, 900], [1512, 982], [1512, 982], [1728, 1117], [1470, 956],
  [1680, 1050], [2240, 1260], [2560, 1440], [1920, 1080], [1280, 800]
]
// macOS on a non-Retina external (1×).
const MAC_1X_SCREENS: Array<[number, number]> = [
  [1920, 1080], [1920, 1080], [2560, 1440], [1920, 1200], [3440, 1440], [1680, 1050]
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
// navigator.deviceMemory is CAPPED at 8 by Chrome and only ever reports a value
// from {0.25,0.5,1,2,4,8}. Anything else (e.g. 16, 6) is impossible → instant flag.
const MEMORY = [4, 8]

interface OsPreset {
  uaParens: string
  uaSuffix: string // "Safari/537.36" or "Mobile Safari/537.36"
  platform: string
  platformVersion: string
  fonts: string[]
  gpus: Array<{ vendor: string; renderer: string }>
  mobile: boolean
}

export type GpuFamily = 'NVIDIA' | 'AMD' | 'Intel' | 'Apple' | 'Qualcomm'

/** Fingerprint VARIETY version stamped on profiles (Profile.fpv). Bump when the per-profile
 *  derivation gains a new dimension and every stored profile must get it once:
 *  2 = cores · RAM · GPU per profile, 3 = + screen per profile. */
export const FP_VARIETY_VERSION = 3

export interface FingerprintEnvironment {
  language?: string
  languages?: string[]
  /** Exact values — only when a caller really wants the host's own numbers. */
  hardwareConcurrency?: number
  deviceMemory?: number
  /** Upper bounds from the real host: a profile may claim FEWER cores / less RAM than
   *  the machine has (harmless), never more (a 16-core claim on a 4-core box is a tell). */
  maxHardwareConcurrency?: number
  maxDeviceMemory?: number
  devicePixelRatio?: number
  /** Exact screen — forces one size (rarely wanted; see minScreen). */
  screen?: { width: number; height: number }
  /** The real primary display in CSS px. A profile may claim a screen this size or LARGER
   *  (its window then always fits inside the claimed screen — even maximized — so
   *  outerWidth/outerHeight/screenX never exceed the claimed bounds), never smaller: a
   *  1920-wide maximized window on a claimed 1366-wide screen is an impossible machine. */
  minScreen?: { width: number; height: number }
  /** The real display's colour depth (24, or 30 on 10-bit Mac panels) — always reported
   *  as is: the panel behind a claimed size is still this one. */
  colorDepth?: number
  /** Number of displays attached. Only a single-display host claims a screen: with two or
   *  more, a window on the second display would sit outside any single claimed screen. */
  displays?: number
  /** The real work-area insets of the primary display in CSS px (taskbar, menu bar, dock),
   *  passed to the engine so the claimed screen's avail* rect has this host's real shape. */
  workAreaInsets?: { left: number; top: number; right: number; bottom: number }
  /** Exact GPU — forces one renderer string (rarely wanted; see webglFamily). */
  webgl?: { vendor: string; renderer: string }
  /** GPU FAMILY of the real host. Each profile then claims a DIFFERENT model of the same
   *  family, so the D3D11/Metal capabilities the engine really exposes stay plausible
   *  while no two profiles on one machine share a renderer string. */
  webglFamily?: GpuFamily
  platformVersion?: string
  timezone?: string
  /** Deterministic seed (the profile id): the same profile gets the same hardware on every
   *  load and on every machine of the same GPU family, instead of a fresh roll each time. */
  seed?: string
}

/** FNV-1a 32-bit — the same derivation the engine uses for --vgc-seed. */
export function hashSeed(value: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export type Rng = () => number

/** mulberry32: tiny, well-distributed PRNG for deterministic per-profile picks. */
export function rngFor(seed: string | undefined): Rng {
  if (!seed) return Math.random
  let a = hashSeed(seed) || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Which GPU family a vendor/renderer string describes (undefined if unrecognised). */
export function gpuFamilyOf(text: string | undefined | null): GpuFamily | undefined {
  const s = (text || '').toLowerCase()
  if (/nvidia|geforce|quadro/.test(s)) return 'NVIDIA'
  if (/\bamd\b|radeon/.test(s)) return 'AMD'
  if (/intel|\biris\b|uhd graphics|hd graphics/.test(s)) return 'Intel'
  if (/apple/.test(s)) return 'Apple'
  if (/adreno|qualcomm/.test(s)) return 'Qualcomm'
  return undefined
}

// The full default Windows 10/11 font set. The universal fonts (also listed in
// ALWAYS_KEEP below) are present on every install and are always exposed — real machines
// all share them, so keeping them is not a cross-profile tell (dropping one WOULD be).
// The rest are regional / language-pack / optional families whose presence varies by
// install; fontSubset() keeps a random per-profile subset of them, and that variation —
// on top of the engine's --vgc-fonts allowlist that HIDES everything else — is what makes
// two profiles on one machine enumerate DIFFERENT font sets instead of the identical real
// one (previously only ~13 fonts, identical across profiles → a same-machine correlator).
const WIN_FONTS = [
  // universal (always kept)
  'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math',
  'Comic Sans MS', 'Consolas', 'Courier New', 'Franklin Gothic Medium', 'Gabriola',
  'Georgia', 'Impact', 'Lucida Console', 'Microsoft Sans Serif', 'MS Gothic',
  'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji',
  'Segoe UI Symbol', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Webdings', 'Wingdings',
  // optional / regional (varied per profile)
  'Candara', 'Constantia', 'Corbel', 'Ebrima', 'Gadugi', 'Ink Free', 'Javanese Text',
  'Leelawadee UI', 'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Himalaya',
  'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Tai Le',
  'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti', 'MV Boli',
  'Myanmar Text', 'Nirmala UI', 'Segoe MDL2 Assets', 'Segoe UI Historic', 'SimSun',
  'Sitka', 'Yu Gothic', 'Yu Gothic UI'
]
const MAC_FONTS = [
  // Universal (in ALWAYS_KEEP → every macOS profile exposes these; real Macs all share them).
  'Arial', 'Geneva', 'Helvetica', 'Helvetica Neue', 'Lucida Grande', 'Menlo',
  'Monaco', 'Times', 'Times New Roman', 'Verdana', 'Courier', 'Courier New',
  // Optional pool — all ship with stock macOS (so they ARE installed and the --vgc-fonts
  // allowlist can actually expose them), but NOT in ALWAYS_KEEP, so fontSubset() keeps each
  // with ~65% probability → two profiles on the same Mac enumerate DIFFERENT font sets.
  // Without this the 12 universal fonts were identical across every profile (a same-machine
  // correlator) and too few for a realistic Mac. A real Mac detects ~35-45 of these.
  'American Typewriter', 'Andale Mono', 'Apple Chancery', 'Arial Black', 'Arial Narrow',
  'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Avenir Next Condensed', 'Baskerville',
  'Big Caslon', 'Bodoni 72', 'Bodoni 72 Oldstyle', 'Bradley Hand', 'Brush Script MT',
  'Chalkboard', 'Chalkboard SE', 'Chalkduster', 'Charter', 'Cochin', 'Comic Sans MS',
  'Copperplate', 'Didot', 'DIN Alternate', 'DIN Condensed', 'Futura', 'Georgia', 'Gill Sans',
  'Herculanum', 'Hoefler Text', 'Impact', 'Kefa', 'Luminari', 'Marker Felt', 'Noteworthy',
  'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'PT Mono', 'PT Sans', 'PT Serif', 'Rockwell',
  'Savoye LET', 'SignPainter', 'Silom', 'Skia', 'Snell Roundhand', 'Superclarendon',
  'Tahoma', 'Trattatello', 'Trebuchet MS', 'Zapfino'
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
    // Real Chrome-on-Windows strings: since ~M105 the ANGLE renderer embeds the GPU's PCI
    // device id ("(0x00002503)"). A string without it is itself a tell, so every pool
    // entry carries the real id of that model. Pools are grouped by family so a host of
    // one family gets a DIFFERENT model of the same family per profile (see gpuPool).
    gpus: [
      ...winGpus('NVIDIA', [
        ['NVIDIA GeForce RTX 3050', '2507'],
        ['NVIDIA GeForce RTX 3060', '2503'],
        ['NVIDIA GeForce RTX 3060 Ti', '2489'],
        ['NVIDIA GeForce RTX 3070', '2484'],
        ['NVIDIA GeForce RTX 3080', '2206'],
        ['NVIDIA GeForce RTX 4060', '2882'],
        ['NVIDIA GeForce RTX 4060 Ti', '2803'],
        ['NVIDIA GeForce RTX 4070', '2786'],
        ['NVIDIA GeForce RTX 4070 SUPER', '2783'],
        ['NVIDIA GeForce RTX 5070', '2F04'],
        ['NVIDIA GeForce GTX 1650', '1F82'],
        ['NVIDIA GeForce GTX 1660 SUPER', '21C4'],
        ['NVIDIA GeForce GTX 1660 Ti', '2182'],
        ['NVIDIA GeForce RTX 2060', '1F08'],
        ['NVIDIA GeForce RTX 3050 Laptop GPU', '25A2'],
        ['NVIDIA GeForce RTX 4060 Laptop GPU', '28E0']
      ]),
      ...winGpus('Intel', [
        ['Intel(R) UHD Graphics 620', '5917'],
        ['Intel(R) UHD Graphics 630', '3E9B'],
        ['Intel(R) UHD Graphics 730', '4692'],
        ['Intel(R) UHD Graphics 770', '4680'],
        ['Intel(R) Iris(R) Xe Graphics', '9A49'],
        ['Intel(R) Iris(R) Plus Graphics', '8A52']
      ]),
      ...winGpus('AMD', [
        ['AMD Radeon RX 580 Series', '67DF'],
        ['AMD Radeon RX 5700 XT', '731F'],
        ['AMD Radeon RX 6600', '73FF'],
        ['AMD Radeon RX 6700 XT', '73DF'],
        ['AMD Radeon RX 7600', '7480'],
        ['AMD Radeon RX 7800 XT', '747E'],
        ['AMD Radeon 780M Graphics', '15BF'],
        ['AMD Radeon(TM) Vega 8 Graphics', '15D8']
      ])
    ],
    mobile: false
  },
  macos: {
    uaParens: 'Macintosh; Intel Mac OS X 10_15_7',
    uaSuffix: 'Safari/537.36',
    platform: 'MacIntel',
    platformVersion: '14.5.0',
    fonts: MAC_FONTS,
    // Real Apple-Silicon / Intel-Mac ANGLE Metal renderer strings. A larger pool so two
    // profiles rarely collide on the same GPU (webglRenderer is a high-signal correlator);
    // 3 entries meant ~11% of any 3 profiles shared a renderer. All are plausible shipping Macs.
    gpus: [
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)' },
      // Intel/AMD Macs: Chrome's ANGLE backend on macOS is Metal, not OpenGL.
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Unspecified Version)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5300M, Unspecified Version)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)' }
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

function pick<T>(arr: T[], rng: Rng = Math.random): T {
  return arr[Math.floor(rng() * arr.length)]
}

/** Windows ANGLE D3D11 renderer strings for one family, with each model's PCI device id. */
function winGpus(
  family: 'NVIDIA' | 'Intel' | 'AMD',
  models: Array<[name: string, deviceIdHex: string]>
): Array<{ vendor: string; renderer: string }> {
  return models.map(([name, id]) => ({
    vendor: `Google Inc. (${family})`,
    renderer: `ANGLE (${family}, ${name} (0x0000${id.toUpperCase()}) Direct3D11 vs_5_0 ps_5_0, D3D11)`
  }))
}

/** Pool of plausible GPUs for an OS, narrowed to one family when known (falls back to
 *  the whole pool when the family has no entries). */
export function gpuPool(os: OsType, family?: GpuFamily): Array<{ vendor: string; renderer: string }> {
  const all = (OS_PRESETS[os] ?? OS_PRESETS.windows).gpus
  const same = family ? all.filter((g) => gpuFamilyOf(`${g.vendor} ${g.renderer}`) === family) : []
  return same.length ? same : all
}

/**
 * The hardware trio (cores · memory · GPU) a profile claims, chosen deterministically from
 * its id within the host's limits — so two profiles on one machine claim DIFFERENT
 * hardware (no shared renderer/core-count correlator), while one profile claims the SAME
 * hardware every time it is opened and on every machine of the same GPU family.
 */
export function hardwareVariant(
  os: OsType,
  environment: FingerprintEnvironment,
  seed: string
): Pick<Fingerprint, 'hardwareConcurrency' | 'deviceMemory' | 'webgl'> {
  const preset = OS_PRESETS[os] ?? OS_PRESETS.windows
  const rng = rngFor(seed + ':hw')
  const coreChoices = (preset.mobile ? [4, 6, 8] : CORES).filter(
    (c) => !environment.maxHardwareConcurrency || c <= environment.maxHardwareConcurrency
  )
  const memChoices = (preset.mobile ? [4, 8] : MEMORY).filter(
    (m) => !environment.maxDeviceMemory || m <= environment.maxDeviceMemory
  )
  // A host smaller than every pool value (2-3 vCPU VPS, <4 GB RAM) claims exactly what it
  // has: Chrome reports real core counts, and 2 GB is a valid deviceMemory value.
  const maxCores = environment.maxHardwareConcurrency
  const maxMem = environment.maxDeviceMemory
  return {
    hardwareConcurrency: coreChoices.length
      ? pick(coreChoices, rng)
      : Math.max(1, Math.floor(maxCores ?? Math.min(...CORES))),
    deviceMemory: memChoices.length
      ? pick(memChoices, rng)
      : [0.25, 0.5, 1, 2, 4, 8].filter((m) => m <= (maxMem ?? 8)).pop() ?? 0.25,
    webgl: environment.webgl ?? pick(gpuPool(os, environment.webglFamily), rng)
  }
}

type ScreenSize = { width: number; height: number }
type ScreenEnvironment = Pick<FingerprintEnvironment, 'minScreen' | 'devicePixelRatio'>

const sameSize = (a: ScreenSize, b: ScreenSize): boolean => a.width === b.width && a.height === b.height

/**
 * Screens a profile may claim on this host, in CSS px: the real primary display (always
 * a coherent claim — it is what the machine is — and weighted highest, because it is the
 * one claim that also survives fullscreen, where the viewport can only be the real
 * panel) plus every pool entry at the host's DPR that is at least as large as it. At a
 * fractional DPR (125 %, 150 %) only panels whose CSS size is integral are offered, so no
 * claim depends on rounding. A portrait display, or one no pool entry can cover (a 5K
 * desktop), has exactly one coherent claim: itself.
 */
export function screenPool(os: OsType, environment: ScreenEnvironment): ScreenSize[] {
  const dpr = environment.devicePixelRatio && environment.devicePixelRatio > 0 ? environment.devicePixelRatio : 1
  const min = environment.minScreen
  if (min && min.height > min.width) return [{ ...min }]
  let candidates: ScreenSize[]
  if (os === 'macos') {
    candidates = (dpr >= 1.5 ? MAC_RETINA_SCREENS : MAC_1X_SCREENS).map(([width, height]) => ({ width, height }))
  } else {
    candidates = WIN_PANELS.filter(([w, h]) => Number.isInteger(w / dpr) && Number.isInteger(h / dpr)).map(
      ([w, h]) => ({ width: w / dpr, height: h / dpr })
    )
  }
  if (!min) return candidates
  const fits = candidates.filter((s) => s.width >= min.width && s.height >= min.height)
  if (!fits.length) return [{ ...min }]
  const extra = fits.some((s) => sameSize(s, min)) ? 2 : 3
  for (let i = 0; i < extra; i++) fits.push({ ...min })
  return fits
}

/** The screen a profile claims: a deterministic pick (by profile id) from screenPool. */
export function screenVariant(os: OsType, environment: ScreenEnvironment, seed: string): ScreenSize {
  return { ...pick(screenPool(os, environment), rngFor(seed + ':screen')) }
}

/**
 * The screen a profile is LAUNCHED with on this host: its own stored claim when this
 * host could really show it (it is in this host's pool: at least the real display, a
 * panel that exists at this DPR/OS), otherwise a deterministic pick from the host's pool.
 * Never persisted — the stored claim stays the profile's identity across machines.
 */
export function launchScreen(
  stored: ScreenSize | undefined,
  os: OsType,
  environment: ScreenEnvironment,
  seed: string
): ScreenSize {
  if (stored && screenPool(os, environment).some((s) => sameSize(s, stored))) {
    return { width: stored.width, height: stored.height }
  }
  return screenVariant(os, environment, seed)
}

// Fonts present on essentially EVERY install of their OS. These are always exposed: every
// real machine of that OS has them (so they don't distinguish "same machine" from "two
// different machines"), and a Windows profile missing e.g. "Segoe UI" would itself be a
// tell. Only the OPTIONAL fonts (not in this set) vary per profile — that's where the
// per-profile font entropy lives. Matched case-insensitively.
const ALWAYS_KEEP_FONTS = new Set(
  [
    // Windows universal
    'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math',
    'Comic Sans MS', 'Consolas', 'Courier New', 'Franklin Gothic Medium', 'Gabriola',
    'Georgia', 'Impact', 'Lucida Console', 'Microsoft Sans Serif', 'MS Gothic',
    'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji',
    'Segoe UI Symbol', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
    'Webdings', 'Wingdings',
    // macOS universal
    'Helvetica', 'Helvetica Neue', 'Geneva', 'Lucida Grande', 'Menlo', 'Monaco', 'Times',
    'Courier',
    // Linux / Android common
    'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif', 'Roboto',
    'Noto Sans', 'Noto Serif'
  ].map((f) => f.toLowerCase())
)

/**
 * Each profile exposes a different detectable font set so no two "chromes" look identical.
 * Universal OS fonts are always kept; every OTHER (optional/regional) font is kept with
 * ~65% probability, so two profiles differ in which optional fonts they expose. Paired with
 * the engine's --vgc-fonts allowlist (which HIDES fonts outside this set), the width-probe /
 * measureText / canvas / FontFaceSet.check all report this per-profile set.
 */
function fontSubset(all: string[], rng: Rng = Math.random): string[] {
  return all.filter((f) => ALWAYS_KEEP_FONTS.has(f.toLowerCase()) || rng() > 0.35)
}

// Map an ISO-3166 country code (from the proxy's IP geo) to the locale a real user
// in that country would run Chrome with. Used at launch to keep navigator.language /
// Accept-Language coherent with the proxy's exit country.
const LOCALE_BY_COUNTRY: Record<string, string> = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE',
  IN: 'en-IN', SG: 'en-SG', PH: 'en-PH', ZA: 'en-ZA',
  FR: 'fr-FR', DE: 'de-DE', AT: 'de-AT', CH: 'de-CH',
  ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CO: 'es-CO',
  IT: 'it-IT', NL: 'nl-NL', BE: 'nl-BE', PT: 'pt-PT', BR: 'pt-BR',
  RU: 'ru-RU', UA: 'uk-UA', PL: 'pl-PL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK',
  FI: 'fi-FI', CZ: 'cs-CZ', RO: 'ro-RO', HU: 'hu-HU', GR: 'el-GR', TR: 'tr-TR',
  JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK',
  VN: 'vi-VN', TH: 'th-TH', ID: 'id-ID', MY: 'ms-MY'
}

/** Coherent locale for a proxy's country code, or null if unknown (keep current). */
export function localeForCountry(
  countryCode?: string
): { language: string; languages: string[] } | null {
  if (!countryCode) return null
  const locale = LOCALE_BY_COUNTRY[countryCode.toUpperCase()]
  if (!locale) return null
  const base = locale.split('-')[0]
  return { language: locale, languages: [locale, base] }
}

/** Generate a self-consistent fingerprint for the given OS. */
export function generateFingerprint(
  os: OsType = 'windows',
  environment: FingerprintEnvironment = {}
): Fingerprint {
  const preset = OS_PRESETS[os] ?? OS_PRESETS.windows
  const rng = rngFor(environment.seed)
  const build = pick(CHROME_BUILDS, rng)
  const seed = environment.seed ?? String(rng())
  const hw = hardwareVariant(os, environment, seed)
  const screen =
    environment.screen ?? (preset.mobile ? pick(MOBILE_SCREENS, rng) : screenVariant(os, environment, seed))
  const timezone = environment.timezone ?? pick(TIMEZONES, rng)
  const language = environment.language ?? 'en-US'
  const languages = environment.languages?.length
    ? environment.languages
    : [language, language.split('-')[0]].filter((v, i, a) => a.indexOf(v) === i)

  const userAgent =
    `Mozilla/5.0 (${preset.uaParens}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${build.major}.0.0.0 ${preset.uaSuffix}`

  return {
    userAgent,
    platform: preset.platform,
    language,
    languages,
    hardwareConcurrency: environment.hardwareConcurrency ?? hw.hardwareConcurrency,
    deviceMemory: environment.deviceMemory ?? hw.deviceMemory,
    vendor: 'Google Inc.',
    screen: {
      ...screen,
      colorDepth: environment.colorDepth ?? 24,
      pixelDepth: environment.colorDepth ?? 24
    },
    devicePixelRatio:
      environment.devicePixelRatio ?? (preset.mobile ? 2.625 : os === 'macos' ? 2 : 1),
    webgl: hw.webgl,
    canvasNoise: true,
    audioNoise: true,
    clientRectsNoise: true,
    webrtc: 'proxy',
    timezone,
    uaFullVersion: build.full,
    uaPlatformVersion: environment.platformVersion ?? preset.platformVersion,
    fonts: fontSubset(preset.fonts, rng),
    doNotTrack: 'unset'
  }
}
