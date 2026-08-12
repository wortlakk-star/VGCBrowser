// VGC Core native fingerprint verification.
//
// This launches the real engine with the same pipe transport and native switches
// used by the app. The page is served from loopback, so the test has a secure
// context without relying on the public internet.

// Run: npm run verify:engine -- /optional/path/to/engine

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from '../src/main/cdp'
import engineRelease from '../src/shared/engine-release.json'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function defaultEngine(): string {
  if (process.platform === 'darwin') {
    return resolve(
      process.cwd(),
      '../vgc-chromium/src/out/vgc/Chromium.app/Contents/MacOS/Chromium'
    )
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'vgc-browser', 'engine', 'chromium', 'chrome.exe')
      : 'D:\\chromium\\src\\out\\vgc\\chrome.exe'
  }
  return resolve(process.cwd(), '../vgc-chromium/src/out/vgc/chrome')
}

const ENGINE = process.argv[2] || process.env.VGC_ENGINE_PATH || defaultEngine()
const FULL_VERSION = engineRelease.chromeVersion
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${FULL_VERSION} Safari/537.36`

interface HttpCapture {
  url: string
  headers: IncomingHttpHeaders
}

interface NativeProbe {
  canvas: {
    hash: string
    directStable: boolean
    urlStable: boolean
    blobStable: boolean
    encodedEqual: boolean
    cropConsistent: boolean
    urlConsistent: boolean
    blobConsistent: boolean
  }
  audio: { hash: string; stable: boolean }
  rect: { value: string; stable: boolean; surfacesAgree: boolean }
  webgl: { vendor: string; renderer: string; hash: string; stable: boolean }
  worker: { cores: number; memory: number; platform: string; languages: string }
  ua: string
  platform: string
  language: string
  languages: string
  cores: number
  memory: number
  timezone: string
  webdriver: boolean
  screen: {
    width: number
    height: number
    availWidth: number
    availHeight: number
    colorDepth: number
    pixelDepth: number
    dpr: number
    mediaWidth: boolean
    mediaHeight: boolean
  }
  uaData: {
    platform: string
    mobile: boolean
    brands: string
    architecture: string
    bitness: string
    platformVersion: string
    uaFullVersion: string
    fullVersionList: string
  }
  nativeGetters: boolean
  heapLimit: number
}

const PROBE = `(async () => {
  const hashBytes = (bytes) => {
    let h = 2166136261;
    for (const value of bytes) {
      h ^= value;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 48;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#1264a3');
  gradient.addColorStop(0.5, '#e8b949');
  gradient.addColorStop(1, '#783a8a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#102030';
  ctx.font = '17px Arial';
  ctx.fillText('VGC native 151', 5, 29);
  ctx.strokeStyle = 'rgba(245,250,255,.82)';
  ctx.beginPath();
  ctx.arc(76, 23, 14, 0, Math.PI * 2);
  ctx.stroke();

  const directA = Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  const directB = Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  const urlA = canvas.toDataURL('image/png');
  const urlB = canvas.toDataURL('image/png');
  const blobA = await new Promise((done) => canvas.toBlob(done, 'image/png'));
  const blobB = await new Promise((done) => canvas.toBlob(done, 'image/png'));

  const readEncoded = async (source) => {
    const bitmap = await createImageBitmap(source);
    const out = document.createElement('canvas');
    out.width = bitmap.width;
    out.height = bitmap.height;
    const outCtx = out.getContext('2d', { willReadFrequently: true });
    outCtx.drawImage(bitmap, 0, 0);
    const bytes = Array.from(outCtx.getImageData(0, 0, out.width, out.height).data);
    bitmap.close();
    return bytes;
  };
  const urlBlob = await (await fetch(urlA)).blob();
  const encodedEqual = equal(
    Array.from(new Uint8Array(await urlBlob.arrayBuffer())),
    Array.from(new Uint8Array(await blobA.arrayBuffer()))
  );
  const urlPixels = await readEncoded(urlBlob);
  const blobPixelsA = await readEncoded(blobA);
  const blobPixelsB = await readEncoded(blobB);

  const cropX = 7, cropY = 5, cropW = 29, cropH = 17;
  const crop = Array.from(ctx.getImageData(cropX, cropY, cropW, cropH).data);
  const cropFromFull = [];
  for (let y = cropY; y < cropY + cropH; y++) {
    const start = (y * canvas.width + cropX) * 4;
    cropFromFull.push(...directA.slice(start, start + cropW * 4));
  }

  const renderAudio = async () => {
    const ac = new OfflineAudioContext(1, 8192, 44100);
    const osc = ac.createOscillator();
    const compressor = ac.createDynamicsCompressor();
    osc.type = 'triangle';
    osc.frequency.value = 997;
    compressor.threshold.value = -35;
    osc.connect(compressor);
    compressor.connect(ac.destination);
    osc.start(0);
    const rendered = await ac.startRendering();
    const samples = rendered.getChannelData(0);
    return Array.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  };
  const audioA = await renderAudio();
  const audioB = await renderAudio();

  const rectNode = document.createElement('span');
  rectNode.textContent = 'VGC rect consistency';
  rectNode.style.cssText = 'position:absolute;left:5.5px;top:7.5px;font:19px Arial';
  document.body.appendChild(rectNode);
  const rectRead = () => {
    const bound = rectNode.getBoundingClientRect();
    const client = rectNode.getClientRects()[0];
    const values = [bound.x, bound.y, bound.width, bound.height];
    return {
      value: values.map((v) => v.toFixed(8)).join(','),
      agree: values.every((v, i) => v === [client.x, client.y, client.width, client.height][i])
    };
  };
  const rectA = rectRead();
  const rectB = rectRead();
  rectNode.remove();

  const glCanvas = document.createElement('canvas');
  glCanvas.width = 32;
  glCanvas.height = 32;
  const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  gl.enable(gl.SCISSOR_TEST);
  const colors = [[.1,.2,.3,1],[.7,.1,.4,1],[.2,.8,.5,1],[.9,.7,.2,1]];
  for (let i = 0; i < 4; i++) {
    gl.scissor((i % 2) * 16, Math.floor(i / 2) * 16, 16, 16);
    gl.clearColor(...colors[i]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  const glRead = () => {
    const bytes = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return Array.from(bytes);
  };
  const glA = glRead();
  const glB = glRead();

  const worker = await new Promise((resolve, reject) => {
    const source = 'self.onmessage=()=>self.postMessage({cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory,platform:navigator.platform,languages:(navigator.languages||[]).join(",")})';
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const instance = new Worker(url);
    const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
    instance.onmessage = ({ data }) => {
      clearTimeout(timer);
      instance.terminate();
      URL.revokeObjectURL(url);
      resolve(data);
    };
    instance.onerror = (event) => reject(new Error(event.message || 'worker failed'));
    instance.postMessage(null);
  });

  const high = await navigator.userAgentData.getHighEntropyValues([
    'architecture', 'bitness', 'platformVersion', 'uaFullVersion', 'fullVersionList'
  ]);
  const nativeSource = (fn) => /\\{\\s*\\[native code\\]\\s*\\}/.test(Function.prototype.toString.call(fn));
  const hcGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency').get;
  const screenGetter = Object.getOwnPropertyDescriptor(Screen.prototype, 'width').get;

  return {
    canvas: {
      hash: hashBytes(directA),
      directStable: equal(directA, directB),
      urlStable: urlA === urlB,
      blobStable: equal(blobPixelsA, blobPixelsB),
      encodedEqual,
      cropConsistent: equal(crop, cropFromFull),
      urlConsistent: equal(directA, urlPixels),
      blobConsistent: equal(directA, blobPixelsA)
    },
    audio: { hash: hashBytes(audioA), stable: equal(audioA, audioB) },
    rect: {
      value: rectA.value,
      stable: rectA.value === rectB.value,
      surfacesAgree: rectA.agree && rectB.agree
    },
    webgl: {
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : '',
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '',
      hash: hashBytes(glA),
      stable: equal(glA, glB)
    },
    worker,
    ua: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: (navigator.languages || []).join(','),
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    webdriver: navigator.webdriver,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      dpr: devicePixelRatio,
      mediaWidth: matchMedia('(device-width: 1920px)').matches,
      mediaHeight: matchMedia('(device-height: 1080px)').matches
    },
    uaData: {
      platform: navigator.userAgentData.platform,
      mobile: navigator.userAgentData.mobile,
      brands: navigator.userAgentData.brands.map((b) => b.brand + ':' + b.version).join('|'),
      architecture: high.architecture,
      bitness: high.bitness,
      platformVersion: high.platformVersion,
      uaFullVersion: high.uaFullVersion,
      fullVersionList: (high.fullVersionList || []).map((b) => b.brand + ':' + b.version).join('|')
    },
    nativeGetters: nativeSource(hcGetter) && nativeSource(screenGetter) && nativeSource(Element.prototype.getBoundingClientRect),
    heapLimit: performance.memory ? performance.memory.jsHeapSizeLimit : 0
  };
})()`

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback test server failed')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit())),
    sleep(3000)
  ])
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
}

async function waitForReady(conn: CdpConnection, sessionId: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = (await conn.send(
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      sessionId
    )) as { result?: { value?: string } }
    if (result.result?.value === 'complete') return
    await sleep(100)
  }
  throw new Error('Test page did not finish loading')
}

async function evaluateProbe(conn: CdpConnection, sessionId: string): Promise<NativeProbe> {
  const result = (await conn.send(
    'Runtime.evaluate',
    { expression: PROBE, returnByValue: true, awaitPromise: true },
    sessionId
  )) as {
    result?: { value?: NativeProbe }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Probe failed'
    )
  }
  if (!result.result?.value) throw new Error('Probe returned no value')
  return result.result.value
}

async function launchProbe(
  pageUrl: string,
  seed: string
): Promise<{ probe: NativeProbe; version: string }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'vgc-native-engine-'))
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--headless=new',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,900',
    '--lang=en-US',
    '--accept-lang=en-US,en',
    `--user-agent=${UA}`,
    `--vgc-ua-full-version=${FULL_VERSION}`,
    '--vgc-ua-platform=Windows',
    '--vgc-ua-platform-version=15.0.0',
    '--vgc-ua-arch=x86',
    '--vgc-ua-bitness=64',
    '--vgc-hardware-concurrency=8',
    '--vgc-device-memory=4',
    '--vgc-platform=Win32',
    '--vgc-webgl-vendor=Google Inc. (NVIDIA)',
    '--vgc-webgl-renderer=ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    '--vgc-timezone=America/New_York',
    '--vgc-accept-languages=en-US,en',
    '--vgc-screen=1920x1080',
    '--vgc-color-depth=24',
    '--force-device-scale-factor=1',
    `--vgc-seed=${seed}`,
    'about:blank'
  ]
  const env: NodeJS.ProcessEnv = { ...process.env, GOOGLE_API_KEY: 'no-key' }
  delete env.GOOGLE_DEFAULT_CLIENT_ID
  delete env.GOOGLE_DEFAULT_CLIENT_SECRET
  const proc = spawn(ENGINE, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString('utf8')
  })
  const write = proc.stdio[3] as Writable
  const read = proc.stdio[4] as Readable
  const conn = CdpConnection.connectPipe(write, read)
  try {
    const browser = (await conn.send('Browser.getVersion')) as { product?: string }
    const created = (await conn.send('Target.createTarget', { url: pageUrl })) as {
      targetId: string
    }
    const attached = (await conn.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true
    })) as { sessionId: string }
    await conn.send('Page.enable', {}, attached.sessionId)
    await conn.send('Runtime.enable', {}, attached.sessionId)
    await waitForReady(conn, attached.sessionId)
    await conn.send('Page.reload', { ignoreCache: true }, attached.sessionId)
    await waitForReady(conn, attached.sessionId)
    return {
      probe: await evaluateProbe(conn, attached.sessionId),
      version: browser.product || ''
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`)
  } finally {
    conn.close()
    await stopProcess(proc)
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  return Array.isArray(value) ? value.join(',') : value || ''
}

async function main(): Promise<void> {
  if (!existsSync(ENGINE)) throw new Error(`VGC Core not found: ${ENGINE}`)
  const captures: HttpCapture[] = []
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/probe')) {
      captures.push({ url: request.url, headers: request.headers })
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Accept-CH': [
        'Sec-CH-UA-Full-Version-List',
        'Sec-CH-UA-Platform-Version',
        'Sec-CH-UA-Arch',
        'Sec-CH-UA-Bitness'
      ].join(', ')
    })
    response.end('<!doctype html><meta charset="utf-8"><title>VGC native probe</title>')
  })
  const port = await listen(server)
  try {
    const first = await launchProbe(`http://127.0.0.1:${port}/probe?run=alpha`, 'native-alpha')
    const second = await launchProbe(`http://127.0.0.1:${port}/probe?run=beta`, 'native-beta')
    const alphaHeaders = captures.filter((capture) => capture.url.includes('run=alpha')).at(-1)?.headers ?? {}
    const checks: Array<[string, boolean, unknown]> = []
    const check = (name: string, pass: boolean, value: unknown): void => {
      checks.push([name, pass, value])
    }
    const a = first.probe
    const b = second.probe
    check('engine version', first.version.includes(FULL_VERSION), first.version)
    check('user agent', a.ua === UA, a.ua)
    check('navigator platform', a.platform === 'Win32', a.platform)
    check('language vector', a.language === 'en-US' && a.languages === 'en-US,en', `${a.language} / ${a.languages}`)
    check('hardware and memory', a.cores === 8 && a.memory === 4, `${a.cores} / ${a.memory}`)
    check('worker native values', a.worker.cores === 8 && a.worker.memory === 4 && a.worker.platform === 'Win32' && a.worker.languages === 'en-US,en', a.worker)
    check('timezone', a.timezone === 'America/New_York', a.timezone)
    check('screen and media queries', a.screen.width === 1920 && a.screen.height === 1080 && a.screen.availWidth === 1920 && a.screen.availHeight === 1040 && a.screen.colorDepth === 24 && a.screen.pixelDepth === 24 && a.screen.dpr === 1 && a.screen.mediaWidth && a.screen.mediaHeight, a.screen)
    check('UA-CH JavaScript', a.uaData.platform === 'Windows' && !a.uaData.mobile && a.uaData.architecture === 'x86' && a.uaData.bitness === '64' && a.uaData.platformVersion === '15.0.0' && a.uaData.uaFullVersion === FULL_VERSION && a.uaData.brands.includes(`Google Chrome:${engineRelease.chromeMajor}`) && a.uaData.fullVersionList.includes(`Google Chrome:${FULL_VERSION}`), a.uaData)
    check('UA-CH request headers', headerValue(alphaHeaders, 'sec-ch-ua').includes(`"Google Chrome";v="${engineRelease.chromeMajor}"`) && headerValue(alphaHeaders, 'sec-ch-ua-platform').includes('Windows') && headerValue(alphaHeaders, 'sec-ch-ua-full-version-list').includes(FULL_VERSION) && headerValue(alphaHeaders, 'sec-ch-ua-platform-version').includes('15.0.0') && headerValue(alphaHeaders, 'sec-ch-ua-arch').includes('x86') && headerValue(alphaHeaders, 'sec-ch-ua-bitness').includes('64'), alphaHeaders)
    check('WebGL identity', a.webgl.vendor === 'Google Inc. (NVIDIA)' && a.webgl.renderer.includes('RTX 3060'), a.webgl)
    check('stable native readbacks', a.canvas.directStable && a.canvas.urlStable && a.canvas.blobStable && a.audio.stable && a.webgl.stable && a.rect.stable, { canvas: a.canvas, audio: a.audio, webgl: a.webgl, rect: a.rect })
    check('canvas surface coherence', a.canvas.encodedEqual && a.canvas.cropConsistent && a.canvas.urlConsistent && a.canvas.blobConsistent, a.canvas)
    check('client rect coherence', a.rect.surfacesAgree, a.rect)
    check('per-seed variation', a.canvas.hash !== b.canvas.hash && a.audio.hash !== b.audio.hash && a.webgl.hash !== b.webgl.hash && a.rect.value !== b.rect.value, { alpha: { canvas: a.canvas.hash, audio: a.audio.hash, webgl: a.webgl.hash, rect: a.rect.value }, beta: { canvas: b.canvas.hash, audio: b.audio.hash, webgl: b.webgl.hash, rect: b.rect.value } })
    check('native descriptors', a.nativeGetters, a.nativeGetters)
    check('no webdriver signal', a.webdriver === false, a.webdriver)
    check('heap coherent with 4 GB', a.heapLimit > 1_500_000_000 && a.heapLimit < 2_600_000_000, a.heapLimit)

    let passed = 0
    console.log(`VGC Core: ${ENGINE}`)
    for (const [name, pass, value] of checks) {
      if (pass) passed++
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(value)}`)
    }
    console.log(`${passed}/${checks.length} native checks passed.`)
    process.exitCode = passed === checks.length ? 0 : 1
  } finally {
    await closeServer(server)
  }
}

main().catch((error) => {
  console.error('engine verify error:', error)
  process.exitCode = 2
})
