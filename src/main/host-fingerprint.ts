import { cpus, totalmem } from 'os'
import { execFileSync } from 'child_process'
import { app, screen } from 'electron'
import type { Fingerprint, OsType } from '../shared/types'
import { generateFingerprint, type FingerprintEnvironment } from '../shared/fingerprint'
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

/** Pick the most render-plausible GPU from all enumerated adapter names. */
function pickRealGpu(names: string[]): string {
  let best = ''
  let bestRank = 0
  for (const raw of names) {
    const name = cleanText(raw, 200).trim()
    if (!name) continue
    const rank = gpuRank(name)
    if (rank > bestRank) {
      best = name
      bestRank = rank
    }
  }
  return best
}

function hostWebgl(): FingerprintEnvironment['webgl'] | undefined {
  if (cachedHostWebgl !== undefined) return cachedHostWebgl ?? undefined
  cachedHostWebgl = null
  try {
    let model = ''
    if (process.platform === 'darwin') {
      const raw = execFileSync('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024
      })
      const parsed = JSON.parse(raw) as { SPDisplaysDataType?: Array<Record<string, unknown>> }
      // Prefer the first Apple/AMD/Intel GPU, skipping any virtual mirror driver.
      const gpus = parsed.SPDisplaysDataType ?? []
      const names = gpus.map((g) => cleanText(g?.sppci_model ?? g?._name, 200).trim())
      model = pickRealGpu(names) || cleanText(gpus[0]?.sppci_model ?? gpus[0]?._name, 200).trim()
    } else if (process.platform === 'win32') {
      // Enumerate EVERY video controller and choose a real GPU, not index 0 (which on a
      // VPS/RDP box is a virtual display like "OrayIddDriver Device" or "Microsoft Basic
      // Display Adapter"). One name per line.
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'
        ],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 }
      )
      model = pickRealGpu(raw.split(/\r?\n/))
    }
    if (model) {
      const family = /nvidia/i.test(model)
        ? 'NVIDIA'
        : /amd|radeon/i.test(model)
          ? 'AMD'
          : /intel/i.test(model)
            ? 'Intel'
            : /apple/i.test(model)
              ? 'Apple'
              : ''
      if (family) {
        cachedHostWebgl = {
          vendor: `Google Inc. (${family})`,
          renderer:
            process.platform === 'darwin'
              ? `ANGLE (${family}, ANGLE Metal Renderer: ${model}, Unspecified Version)`
              : `ANGLE (${family}, ${model} Direct3D11 vs_5_0 ps_5_0, D3D11)`
        }
      }
    }
  } catch {
    cachedHostWebgl = null
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

  const environment: FingerprintEnvironment = {
    language: locale,
    languages: [locale, baseLocale].filter((v, i, a) => a.indexOf(v) === i),
    hardwareConcurrency: cores,
    deviceMemory,
    devicePixelRatio: scaleFactor,
    ...(displaySize ? { screen: displaySize } : {}),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(hostWebgl() ? { webgl: hostWebgl() } : {})
  }

  if (process.platform === 'darwin') {
    environment.platformVersion = (
      process as NodeJS.Process & { getSystemVersion?: () => string }
    ).getSystemVersion?.()
    if (process.arch === 'arm64' && !environment.webgl) {
      const model = cpus()[0]?.model?.match(/Apple M[^\s]*(?:\s+(?:Pro|Max|Ultra))?/i)?.[0] ?? 'Apple M1'
      environment.webgl = {
        vendor: 'Google Inc. (Apple)',
        renderer: `ANGLE (Apple, ANGLE Metal Renderer: ${model}, Unspecified Version)`
      }
    }
  }
  return environment
}

export function cohereFingerprint(candidate?: Fingerprint): Fingerprint {
  const environment = hostFingerprintEnvironment()
  const baseline = generateFingerprint(hostOs(), environment)
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return baseline
  const samePlatform = candidate.platform === baseline.platform
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
  const webgl =
    !environment.webgl &&
    samePlatform &&
    candidate.webgl &&
    typeof candidate.webgl.vendor === 'string' &&
    typeof candidate.webgl.renderer === 'string' &&
    candidate.webgl.vendor.length <= 256 &&
    candidate.webgl.renderer.length <= 1024
      ? {
          vendor: cleanText(candidate.webgl.vendor, 256),
          renderer: cleanText(candidate.webgl.renderer, 1024)
        }
      : baseline.webgl
  return {
    ...baseline,
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
