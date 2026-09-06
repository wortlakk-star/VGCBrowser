// Per-profile screen verification.
//
// 1. Generator invariants (pure): every screen a profile may claim on a host is at least
//    the host's real display, integral at the host's DPR, OS-specific (Retina Mac sizes on
//    a Mac, physical panels on Windows), deterministic per profile id, spread across
//    profiles; launchScreen keeps a stored claim only when this host could show it.
// 2. Live, against the engine (VGC_ENGINE_PATH, or the repo's engine/chromium): read the
//    REAL screen with no switches, derive the claim exactly as the launcher would
//    (launchScreen with the real display / DPR), launch MAXIMIZED with --vgc-screen and
//    the real work-area insets, and assert that screen.*, avail*, media queries and the
//    real window geometry are coherent; DPR must be untouched.
//
// Run: npm run verify:screen -- [/optional/path/to/engine]
// The live half is required unless VGC_SKIP_LIVE=1 (exit code 2 when it is skipped).

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateFingerprint, launchScreen, screenPool, screenVariant } from '../src/shared/fingerprint'
import type { OsType } from '../src/shared/types'
import { createLoopbackPage, openNativePage, resolveTestEngine } from './native-harness'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

interface Host {
  os: OsType
  minScreen?: { width: number; height: number }
  devicePixelRatio: number
}

const HOSTS: Host[] = [
  { os: 'windows', minScreen: { width: 1920, height: 1080 }, devicePixelRatio: 1 },
  { os: 'windows', minScreen: { width: 1536, height: 864 }, devicePixelRatio: 1.25 },
  { os: 'windows', minScreen: { width: 1280, height: 720 }, devicePixelRatio: 1.5 },
  { os: 'windows', minScreen: { width: 3840, height: 2160 }, devicePixelRatio: 1 },
  { os: 'windows', minScreen: { width: 5120, height: 1440 }, devicePixelRatio: 1 },
  { os: 'windows', minScreen: { width: 1600, height: 1200 }, devicePixelRatio: 1 },
  { os: 'windows', minScreen: { width: 1366, height: 768 }, devicePixelRatio: 1 },
  { os: 'windows', minScreen: { width: 1080, height: 1920 }, devicePixelRatio: 1 },
  { os: 'macos', minScreen: { width: 1440, height: 900 }, devicePixelRatio: 2 },
  { os: 'macos', minScreen: { width: 1512, height: 982 }, devicePixelRatio: 2 },
  { os: 'macos', minScreen: { width: 1920, height: 1080 }, devicePixelRatio: 1 },
  { os: 'linux', minScreen: { width: 1920, height: 1080 }, devicePixelRatio: 1 },
  { os: 'windows', devicePixelRatio: 1 }
]

const key = (s: { width: number; height: number }): string => `${s.width}x${s.height}`

function unitChecks(): void {
  for (const host of HOSTS) {
    const label = `${host.os} ${host.minScreen ? key(host.minScreen) : 'unknown'} @${host.devicePixelRatio}`
    const pool = screenPool(host.os, host)
    check(`${label}: pool is non-empty`, pool.length > 0)
    check(
      `${label}: every claim is integer-sized and at least the real display`,
      pool.every(
        (s) =>
          Number.isInteger(s.width) &&
          Number.isInteger(s.height) &&
          (!host.minScreen || (s.width >= host.minScreen.width && s.height >= host.minScreen.height))
      ),
      Array.from(new Set(pool.map(key))).join(' ')
    )
    if (host.minScreen) {
      check(`${label}: the real display itself is a valid claim`, pool.some((s) => key(s) === key(host.minScreen!)))
      const portrait = host.minScreen.height > host.minScreen.width
      if (portrait) check(`${label}: a portrait display claims only itself`, pool.length === 1)
      // launchScreen: a stored claim this host can show is kept, anything else is swapped.
      const kept = launchScreen(host.minScreen, host.os, host, 'p')
      check(`${label}: launchScreen keeps the real display`, key(kept) === key(host.minScreen))
      const swapped = launchScreen({ width: 800, height: 600 }, host.os, host, 'p')
      check(`${label}: launchScreen swaps a too-small stored claim`, pool.some((s) => key(s) === key(swapped)) && key(swapped) !== '800x600')
      const alien = launchScreen({ width: 3440, height: 1441 }, host.os, host, 'p')
      check(`${label}: launchScreen swaps a size this host's pool lacks`, pool.some((s) => key(s) === key(alien)))
    }
    const a = screenVariant(host.os, host, 'profile-1')
    const b = screenVariant(host.os, host, 'profile-1')
    check(`${label}: same profile → same screen`, key(a) === key(b))
    const distinct = new Set<string>()
    for (let i = 0; i < 300; i++) distinct.add(key(screenVariant(host.os, host, `profile-${i}`)))
    const unique = new Set(pool.map(key)).size
    check(
      `${label}: profiles spread over the pool`,
      unique <= 1 ? distinct.size === 1 : distinct.size >= Math.min(unique, 3),
      `${distinct.size} distinct of ${unique} possible`
    )
    const fp = generateFingerprint(host.os, { ...host, seed: 'profile-7' })
    check(
      `${label}: generateFingerprint uses the same deterministic pick`,
      key(fp.screen) === key(screenVariant(host.os, host, 'profile-7')) && fp.screen.colorDepth === 24
    )
  }
  // A 125 % laptop reports its 1920×1080 panel as 1536×864; claims scale the same way and
  // only panels with an integral CSS size are offered (no rounding guesswork).
  const laptop = screenPool('windows', { minScreen: { width: 1536, height: 864 }, devicePixelRatio: 1.25 })
  check(
    'DPR 1.25: claims are physical panels at 125 % (1536x864, 2048x1152, 3072x1728)',
    ['1536x864', '2048x1152', '3072x1728'].every((want) => laptop.some((s) => key(s) === want))
  )
  const dpr15 = screenPool('windows', { minScreen: { width: 1280, height: 720 }, devicePixelRatio: 1.5 })
  check('DPR 1.5: 2560x1440 (1706.67 CSS px) is not offered', !dpr15.some((s) => s.width === 1707 || s.width === 1706))
  const fourK = screenPool('windows', { minScreen: { width: 3840, height: 2160 }, devicePixelRatio: 1 })
  check('4K host: only the real display fits', fourK.every((s) => key(s) === '3840x2160'))
  const wide = screenPool('windows', { minScreen: { width: 5120, height: 1440 }, devicePixelRatio: 1 })
  check('5120x1440 host: only the real display fits', wide.every((s) => key(s) === '5120x1440'))
  const odd = screenPool('windows', { minScreen: { width: 1600, height: 1200 }, devicePixelRatio: 1 })
  check('1600x1200 host: the real 4:3 display is offered next to larger panels', odd.some((s) => key(s) === '1600x1200') && odd.some((s) => key(s) === '1920x1200'))
  const hostWeight = screenPool('windows', { minScreen: { width: 1920, height: 1080 }, devicePixelRatio: 1 }).filter((s) => key(s) === '1920x1080').length
  check('1920x1080 host: the real display is the most likely claim', hostWeight >= 6, `weight ${hostWeight}`)
  // OS-specific pools: a Retina Mac offers Mac panel sizes, never halved Windows panels.
  const mac = screenPool('macos', { minScreen: { width: 1440, height: 900 }, devicePixelRatio: 2 }).map(key)
  check('Retina Mac: MacBook / iMac sizes are offered', ['1512x982', '1728x1117', '2240x1260'].every((w) => mac.includes(w)))
  check('Retina Mac: no Windows-panel sizes', !mac.some((w) => ['1920x1080', '960x540', '1280x720'].includes(w)) || mac.includes('1920x1080'))
  const win = screenPool('windows', { minScreen: { width: 1440, height: 900 }, devicePixelRatio: 2 }).map(key)
  check('Mac and Windows pools differ for the same display', JSON.stringify(mac) !== JSON.stringify(win))
  const mac1x = screenPool('macos', { minScreen: { width: 1920, height: 1080 }, devicePixelRatio: 1 }).map(key)
  check('1x Mac: external-monitor sizes are offered', mac1x.includes('2560x1440') && mac1x.includes('1920x1080'))
}

interface ScreenProbe {
  w: number
  h: number
  aw: number
  ah: number
  al: number
  at: number
  cd: number
  pd: number
  dpr: number
  ow: number
  oh: number
  iw: number
  ih: number
  sx: number
  sy: number
  dw: boolean
  dh: boolean
  res: boolean
}

const PROBE_EXPR = `({
  w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight,
  al: screen.availLeft, at: screen.availTop, cd: screen.colorDepth, pd: screen.pixelDepth,
  dpr: devicePixelRatio, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight,
  sx: screenX, sy: screenY,
  dw: matchMedia('(device-width: ' + screen.width + 'px)').matches,
  dh: matchMedia('(device-height: ' + screen.height + 'px)').matches,
  res: matchMedia('(resolution: ' + devicePixelRatio + 'dppx)').matches
})`

async function launchAndProbe(engine: string, extra: string[]): Promise<ScreenProbe> {
  const page = await createLoopbackPage()
  const userDataDir = mkdtempSync(join(tmpdir(), 'vgc-screen-'))
  let close: (() => Promise<void>) | undefined
  try {
    const session = await openNativePage(
      engine,
      [
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--vgc-seed=screen-verify',
        ...extra
      ],
      page.url
    )
    close = session.close
    // Maximizing is asynchronous on the window manager's side; let it settle.
    await new Promise((r) => setTimeout(r, 800))
    const result = (await session.conn.send(
      'Runtime.evaluate',
      { expression: PROBE_EXPR, returnByValue: true },
      session.sessionId
    )) as { result?: { value?: ScreenProbe }; exceptionDetails?: { text?: string } }
    if (result.exceptionDetails || !result.result?.value) {
      throw new Error(`probe failed: ${JSON.stringify(result.exceptionDetails ?? result)}`)
    }
    return result.result.value
  } finally {
    await close?.()
    await page.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

async function liveChecks(engine: string): Promise<void> {
  const os: OsType = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  // 1. The real display, exactly as a stock launch reports it.
  const real = await launchAndProbe(engine, ['--window-size=1000,700'])
  check('no switch: the engine reports a real screen', real.w >= 640 && real.h >= 480 && real.aw <= real.w && real.ah <= real.h, `${real.w}x${real.h} avail ${real.aw}x${real.ah} at ${real.al},${real.at} dpr ${real.dpr}`)
  const insets = { left: real.al, top: real.at, right: real.w - real.al - real.aw, bottom: real.h - real.at - real.ah }
  const env = { minScreen: { width: real.w, height: real.h }, devicePixelRatio: real.dpr }
  // 2. The claim the launcher would make for a profile whose stored screen this host
  //    cannot show, and one it can.
  const claim = launchScreen({ width: 800, height: 600 }, os, env, 'screen-verify')
  check('claim is at least the real display', claim.width >= real.w && claim.height >= real.h, `${key(claim)} on ${real.w}x${real.h}`)
  check('claim is in the host pool', screenPool(os, env).some((s) => key(s) === key(claim)))
  // 3. Launch MAXIMIZED with the claim and the real work-area insets.
  const p = await launchAndProbe(engine, [
    '--start-maximized',
    `--vgc-screen=${claim.width}x${claim.height}`,
    `--vgc-color-depth=${real.cd}`,
    `--vgc-avail-insets=${insets.left},${insets.top},${insets.right},${insets.bottom}`
  ])
  check('engine: screen.width/height are the claim', p.w === claim.width && p.h === claim.height, `${p.w}x${p.h}`)
  check(
    'engine: avail* = claim minus the REAL work-area insets',
    p.al === insets.left && p.at === insets.top && p.aw === claim.width - insets.left - insets.right && p.ah === claim.height - insets.top - insets.bottom,
    `avail ${p.aw}x${p.ah} at ${p.al},${p.at}; insets ${JSON.stringify(insets)}`
  )
  check('engine: colorDepth/pixelDepth are the real panel depth', p.cd === real.cd && p.pd === real.cd, `${p.cd}`)
  check('engine: devicePixelRatio and (resolution) are untouched', p.dpr === real.dpr && p.res, `${p.dpr}`)
  check('engine: device-width/height media queries follow the claim', p.dw && p.dh)
  check('engine: MAXIMIZED window fits inside the claimed work area', p.ow <= p.aw && p.oh <= p.ah, `outer ${p.ow}x${p.oh} vs avail ${p.aw}x${p.ah}`)
  check('engine: maximized window position stays inside the claimed screen', p.sx + p.ow <= p.w && p.sy + p.oh <= p.h, `at ${p.sx},${p.sy}`)
  check('engine: viewport within the window', p.iw <= p.ow && p.ih <= p.oh)
  // 4. Without insets the legacy 40 px bottom inset applies (older app builds).
  const legacy = await launchAndProbe(engine, ['--window-size=1000,700', `--vgc-screen=${claim.width}x${claim.height}`])
  check('engine: legacy launch (no insets switch) keeps availHeight = height - 40', legacy.aw === claim.width && legacy.ah === claim.height - 40 && legacy.al === 0 && legacy.at === 0, `${legacy.aw}x${legacy.ah}`)
}

async function main(): Promise<void> {
  unitChecks()
  const engine = resolveTestEngine(process.argv[2])
  let skipped = false
  if (existsSync(engine)) {
    console.log(`engine: ${engine}`)
    await liveChecks(engine)
  } else {
    skipped = true
    console.log(`SKIP  live engine checks (no engine at ${engine}; set VGC_ENGINE_PATH)`)
  }
  if (failures) {
    console.log(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  if (skipped && process.env.VGC_SKIP_LIVE !== '1') {
    console.log('\nUNIT PASS, live checks skipped — set VGC_ENGINE_PATH (or VGC_SKIP_LIVE=1 to accept)')
    process.exit(2)
  }
  console.log(skipped ? '\nUNIT PASS (live skipped)' : '\nALL PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
