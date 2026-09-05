import { cpus, totalmem } from 'os'
import { execFileSync } from 'child_process'
import { app, screen } from 'electron'
import type { Fingerprint, OsType } from '../shared/types'
import {
  generateFingerprint,
  gpuFamilyOf,
  gpuPool,
  hardwareVariant,
  rngFor,
  type FingerprintEnvironment,
  type GpuFamily
} from '../shared/fingerprint'
import { cleanText } from './validation'

let cachedHostWebgl: FingerprintEnvironment['webgl'] | null | undefined

// Virtual / remote-desktop / BMC display adapters that Chrome does NOT render with.
// On a VPS, an RDP session, or a remote-control tool (Oray/Parsec/AnyDesk…) the FIRST
// enumerated Win32_VideoController is often one of these, not the real GPU — so
// selecting index 0 made the WebGL renderer spoof claim a virtual adapter (or, when it
// resolved to no family, fall back to a pool GPU that then contradicts the real one and
// the WebGPU adapter). Skip these and pick a real GPU instead.
const VIRTUAL_ADAPTER =
  /virtual|basic (display|render)|remote|\bidd\b|oray|parsec|rustdesk|dameware|\bvnc\b|teamviewer|anydesk|citrix|mirror|meta\b|vmware|virtualbox|hyper-?v|\bqxl\b|virtio|displaylink|spacedesk|aspeed|matrox|standard vga|microsoft/i

/** Rank a GPU name: discrete NVIDIA/AMD first, then Intel/Apple integrated, 0 = unusable. */
function gpuRank(name: string): number {
  if (VIRTUAL_ADAPTER.test(name)) return 0
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|amd|radeon/i.test(name)) return 3
  if (/intel|iris|\buhd\b|\bhd graphics\b/i.test(name)) return 2
  if (/apple/i.test(name)) return 2
  return 0
}

/** Pick the most render-plausible GPU from all enumerated adapter names. Each entry may
 *  carry its PNP id after a '|' ("NVIDIA GeForce RTX 5070 Ti|PCI\VEN_10DE&DEV_2C05&…");
 *  the PCI device id is returned alongside, because real Chrome embeds it in the ANGLE
 *  renderer string ("… RTX 5070 Ti (0x00002C05) Direct3D11 …"). */
function pickRealGpu(entries: string[]): { name: string; deviceId: string } {
  let best = { name: '', deviceId: '' }
  let bestRank = 0
  for (const raw of entries) {
    const [namePart, pnp = ''] = String(raw ?? '').split('|')
    const name = cleanText(namePart, 200).trim()
    if (!name) continue
    const rank = gpuRank(name)
    if (rank > bestRank) {
      const dev = /DEV_([0-9A-Fa-f]{4})/.exec(pnp)?.[1] ?? ''
      best = { name, deviceId: dev.toUpperCase() }
      bestRank = rank
    }
  }
  return best
}

let cachedHostGpuModel: { name: string; deviceId: string } | null | undefined
let gpuDetectionFailed = false

/** True when the last GPU enumeration THREW (PowerShell timeout, WMI down) rather than
 *  genuinely finding no real GPU. Callers that would persist a family-dependent choice
 *  (the store's one-time variety pass) wait for a later, successful enumeration. */
export function hostGpuDetectionFailed(): boolean {
  return gpuDetectionFailed
}

/** The real host GPU model (and PCI device id on Windows), or null when only virtual /
 *  remote-desktop adapters are present. A failed enumeration is NOT cached — the next
 *  call retries. */
function hostGpuModel(): { name: string; deviceId: string } | null {
  if (cachedHostGpuModel !== undefined) return cachedHostGpuModel
  try {
    if (process.platform === 'darwin') {
      const raw = execFileSync('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024
      })
      const parsed = JSON.parse(raw) as { SPDisplaysDataType?: Array<Record<string, unknown>> }
      const gpus = parsed.SPDisplaysDataType ?? []
      const names = gpus.map((g) => cleanText(g?.sppci_model ?? g?._name, 200).trim())
      const picked = pickRealGpu(names)
      const fallback = cleanText(gpus[0]?.sppci_model ?? gpus[0]?._name, 200).trim()
      cachedHostGpuModel = picked.name ? picked : fallback ? { name: fallback, deviceId: '' } : null
    } else if (process.platform === 'win32') {
      // Enumerate EVERY video controller and choose a real GPU, not index 0 (which on a
      // VPS/RDP box is a virtual display like "OrayIddDriver Device" or "Microsoft Basic
      // Display Adapter"). One "Name|PNPDeviceID" per line.
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + "|" + $_.PNPDeviceID }'
        ],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 }
      )
      const picked = pickRealGpu(raw.split(/\r?\n/))
      cachedHostGpuModel = picked.name ? picked : null
    } else {
      cachedHostGpuModel = null
    }
    gpuDetectionFailed = false
  } catch {
    // Transient failure: leave the cache empty so the next call retries.
    gpuDetectionFailed = true
    return null
  }
  return cachedHostGpuModel
}

/** GPU family of the real host, undefined when no real GPU is visible (RDP-only, BMC). */
export function hostGpuFamily(): GpuFamily | undefined {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'Apple'
  return gpuFamilyOf(hostGpuModel()?.name)
}

/** The host's own GPU as a Chrome-style renderer string (with the PCI id on Windows).
 *  Only used as the pool fallback for a family the pool has no entries for. */
function hostWebgl(): FingerprintEnvironment['webgl'] | undefined {
  if (cachedHostWebgl !== undefined) return cachedHostWebgl ?? undefined
  cachedHostWebgl = null
  const model = hostGpuModel()
  const family = gpuFamilyOf(model?.name)
  if (model && family) {
    const idPart = model.deviceId ? ` (0x0000${model.deviceId})` : ''
    cachedHostWebgl = {
      vendor: `Google Inc. (${family})`,
      renderer:
        process.platform === 'darwin'
          ? `ANGLE (${family}, ANGLE Metal Renderer: ${model.name}, Unspecified Version)`
          : `ANGLE (${family}, ${model.name}${idPart} Direct3D11 vs_5_0 ps_5_0, D3D11)`
    }
  }
  return cachedHostWebgl ?? undefined
}

export function hostOs(): OsType {
  return process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : 'linux'
}

export function hostFingerprintEnvironment(): FingerprintEnvironment {
  const locale = (app.getLocale() || 'en-US').replace('_', '-')
  const baseLocale = locale.split('-')[0]
  const cores = Math.max(2, Math.min(32, cpus().length || 4))
  const ramGb = totalmem() / 1073741824
  const deviceMemory = ramGb < 4 ? 2 : ramGb < 8 ? 4 : 8
  let scaleFactor = process.platform === 'darwin' ? 2 : 1
  let displaySize: { width: number; height: number } | undefined
  try {
    const display = screen.getPrimaryDisplay()
    scaleFactor = display.scaleFactor || scaleFactor
    if (display.size.width >= 640 && display.size.height >= 480) {
      displaySize = { width: display.size.width, height: display.size.height }
    }
  } catch {
    // Electron screen is unavailable before app.ready; the platform default is safe.
  }

  // The host sets BOUNDS and the GPU FAMILY, not exact values: every profile then claims
  // its own (deterministic) core count / RAM / GPU model within what this machine can
  // plausibly be — instead of all profiles copying the host and becoming one big
  // same-machine correlator (285 profiles × the identical "RTX 3050 Laptop", 32 cores).
  const family = hostGpuFamily()
  const environment: FingerprintEnvironment = {
    language: locale,
    languages: [locale, baseLocale].filter((v, i, a) => a.indexOf(v) === i),
    maxHardwareConcurrency: cores,
    maxDeviceMemory: deviceMemory,
    devicePixelRatio: scaleFactor,
    ...(displaySize ? { screen: displaySize } : {}),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(family ? { webglFamily: family } : {})
  }
  // A family the pool cannot vary (nothing plausible to pick) falls back to the real GPU.
  if (family && gpuPool(hostOs(), family).every((g) => gpuFamilyOf(g.renderer) !== family)) {
    const real = hostWebgl()
    if (real) environment.webgl = real
  }

  if (process.platform === 'darwin') {
    environment.platformVersion = (
      process as NodeJS.Process & { getSystemVersion?: () => string }
    ).getSystemVersion?.()
  }
  return environment
}

const CHROME_MEMORY_VALUES = [0.25, 0.5, 1, 2, 4, 8]

/**
 * What the engine should actually be launched with on THIS host: the profile's own
 * hardware claims, clamped to what this machine can back up — a claim of more cores /
 * RAM than the box has, or a GPU family the box does not render with (D3D11 caps and
 * WebGPU identity are the real GPU's), is swapped for a deterministic pick within the
 * host's limits. NOT persisted: the stored profile keeps its canonical values, so a
 * profile that travels between an NVIDIA laptop and an Intel desktop does not ping-pong
 * its fingerprint through the cloud on every open.
 */
export function adaptFingerprintToHost(fp: Fingerprint, seedKey: string): Fingerprint {
  const environment = hostFingerprintEnvironment()
  const variant = hardwareVariant(hostOs(), environment, seedKey)
  const next: Fingerprint = { ...fp }
  const maxCores = environment.maxHardwareConcurrency
  if (
    !Number.isInteger(fp.hardwareConcurrency) ||
    fp.hardwareConcurrency < 1 ||
    (maxCores !== undefined && fp.hardwareConcurrency > maxCores)
  ) {
    next.hardwareConcurrency = variant.hardwareConcurrency
  }
  const maxMem = environment.maxDeviceMemory
  if (
    !CHROME_MEMORY_VALUES.includes(fp.deviceMemory) ||
    (maxMem !== undefined && fp.deviceMemory > maxMem)
  ) {
    next.deviceMemory = variant.deviceMemory
  }
  const claimedFamily = gpuFamilyOf(`${fp.webgl?.vendor ?? ''} ${fp.webgl?.renderer ?? ''}`)
  if (environment.webglFamily && claimedFamily !== environment.webglFamily) {
    next.webgl = variant.webgl
  }
  return next
}

/**
 * Sanitise a stored/incoming fingerprint against this host. Hardware claims the profile
 * already has (cores · RAM · GPU) are KEPT when they are plausible values — they are the
 * profile's identity (per-profile, deterministic, or user-edited) — and only replaced by
 * a deterministic pick (seeded by `seedKey`, normally the profile id) when missing or
 * impossible. Host-specific adaptation happens at launch (adaptFingerprintToHost).
 */
export function cohereFingerprint(candidate?: Fingerprint, seedKey?: string): Fingerprint {
  const environment = hostFingerprintEnvironment()
  const baseline = generateFingerprint(hostOs(), { ...environment, ...(seedKey ? { seed: seedKey } : {}) })
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return baseline
  const samePlatform = candidate.platform === baseline.platform
  const cores = Number(candidate.hardwareConcurrency)
  const hardwareConcurrency =
    Number.isInteger(cores) && cores >= 1 && cores <= 64 ? cores : baseline.hardwareConcurrency
  const deviceMemory = CHROME_MEMORY_VALUES.includes(candidate.deviceMemory)
    ? candidate.deviceMemory
    : baseline.deviceMemory
  const width = Number(candidate.screen?.width)
  const height = Number(candidate.screen?.height)
  const candidateScreen =
    Number.isInteger(width) && width >= 800 && width <= 7680 &&
    Number.isInteger(height) && height >= 600 && height <= 4320
      ? { width, height, colorDepth: 24, pixelDepth: 24 }
      : baseline.screen
  // Use the real primary-display geometry whenever Electron can provide it. This keeps
  // screen, DPR, media queries, compositor sizing and outerWidth on one physical model.
  const screenValue = environment.screen ? baseline.screen : candidateScreen
  let timezone = baseline.timezone
  try {
    if (typeof candidate.timezone === 'string' && candidate.timezone.length <= 100) {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate.timezone }).format()
      timezone = candidate.timezone
    }
  } catch {
    // Keep the generated valid IANA timezone.
  }
  const candidateFonts = samePlatform && Array.isArray(candidate.fonts)
    ? candidate.fonts
        .map((font) => cleanText(font, 100).trim())
        .filter((font) => font && !font.includes(','))
        .slice(0, 80)
    : baseline.fonts
  const fonts: string[] = []
  let fontBytes = 0
  for (const font of candidateFonts) {
    const bytes = Buffer.byteLength(font, 'utf8') + 1
    if (fontBytes + bytes > 4096) break
    fonts.push(font)
    fontBytes += bytes
  }
  const latitude = Number(candidate.geolocation?.latitude)
  const longitude = Number(candidate.geolocation?.longitude)
  const accuracy = Number(candidate.geolocation?.accuracy)
  const geolocation =
    Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      ? { latitude, longitude, accuracy: Number.isFinite(accuracy) ? Math.max(1, Math.min(100_000, accuracy)) : 100 }
      : undefined
  const publicIp = cleanText(candidate.webrtcPublicIp, 64).trim()
  // Keep the profile's own GPU whenever it is a sane ANGLE string of a known family (any
  // family: cross-host adaptation is done at launch, never written back).
  const webgl =
    samePlatform &&
    candidate.webgl &&
    typeof candidate.webgl.vendor === 'string' &&
    typeof candidate.webgl.renderer === 'string' &&
    candidate.webgl.vendor.length <= 256 &&
    candidate.webgl.renderer.length <= 1024 &&
    gpuFamilyOf(`${candidate.webgl.vendor} ${candidate.webgl.renderer}`)
      ? {
          vendor: cleanText(candidate.webgl.vendor, 256),
          renderer: cleanText(candidate.webgl.renderer, 1024)
        }
      : baseline.webgl
  return {
    ...baseline,
    hardwareConcurrency,
    deviceMemory,
    screen: screenValue,
    webgl,
    fonts: fonts.length ? fonts : baseline.fonts,
    timezone,
    ...(geolocation ? { geolocation } : {}),
    ...(publicIp ? { webrtcPublicIp: publicIp } : {}),
    canvasNoise: true,
    audioNoise: true,
    clientRectsNoise: true,
    webrtc: candidate.webrtc === 'real' ? 'real' : 'proxy',
    doNotTrack: ['0', '1', 'unset'].includes(String(candidate.doNotTrack))
      ? candidate.doNotTrack
      : 'unset'
  }
}
