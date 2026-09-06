// GPU surface probe: everything a page can learn about the GPU BESIDES the renderer
// string — WebGL 1/2 parameters, extensions, shader precision, WebGPU adapter info /
// features / limits — for one claimed GPU, as JSON. Run it twice with different claims
// (or against stock Chrome) and diff the files: whatever differs with the claim is
// spoofed, whatever stays the same is the real GPU's and must be plausible for the claim.
//
// Run: npm run -s probe:gpu -- [/path/to/engine] > out.json   (-s keeps npm's banner out)
// Env: VGC_CLAIM_VENDOR / VGC_CLAIM_RENDERER (default: NVIDIA GeForce RTX 3060, D3D11),
//      VGC_PROBE_HEADLESS=1 to use headless (SwiftShader-ish; the real GPU needs headful).

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopbackPage, openNativePage, resolveTestEngine } from './native-harness'

const VENDOR = process.env.VGC_CLAIM_VENDOR || 'Google Inc. (NVIDIA)'
const RENDERER =
  process.env.VGC_CLAIM_RENDERER ||
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)'

const PROBE = `(async () => {
  const out = { claim: { vendor: ${JSON.stringify(VENDOR)}, renderer: ${JSON.stringify(RENDERER)} } };
  const norm = (v) => ArrayBuffer.isView(v) ? Array.from(v) : v;
  for (const kind of ['webgl', 'webgl2']) {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext(kind);
    if (!gl) { out[kind] = null; continue; }
    const params = {};
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(Object.getPrototypeOf(gl)))
      .concat(Object.getOwnPropertyNames(Object.getPrototypeOf(gl)));
    for (const name of names) {
      if (name !== name.toUpperCase() || typeof gl[name] !== 'number') continue;
      if (!/^(MAX_|ALIASED_|SUBPIXEL_BITS|SAMPLES$|SAMPLE_BUFFERS$|DEPTH_BITS|STENCIL_BITS|RED_BITS|GREEN_BITS|BLUE_BITS|ALPHA_BITS|IMPLEMENTATION_|SHADING_LANGUAGE_VERSION|VERSION$|RENDERER$|VENDOR$|MIN_PROGRAM_TEXEL_OFFSET|UNIFORM_BUFFER_OFFSET_ALIGNMENT)/.test(name)) continue;
      try { const v = gl.getParameter(gl[name]); if (v !== null && gl.getError() === 0) params[name] = norm(v); } catch (e) {}
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const precision = {};
    for (const shader of ['VERTEX_SHADER', 'FRAGMENT_SHADER']) {
      for (const p of ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT']) {
        const f = gl.getShaderPrecisionFormat(gl[shader], gl[p]);
        precision[shader + '.' + p] = f ? [f.rangeMin, f.rangeMax, f.precision] : null;
      }
    }
    out[kind] = {
      unmasked: dbg ? { vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) } : null,
      maxAnisotropy: aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : null,
      extensions: gl.getSupportedExtensions(),
      params,
      precision,
      contextAttributes: gl.getContextAttributes()
    };
  }
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) out.webgpu = null;
      else {
        const info = adapter.info || {};
        const limits = {};
        for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(adapter.limits))) {
          if (k === 'constructor') continue;
          try { limits[k] = adapter.limits[k]; } catch (e) {}
        }
        out.webgpu = {
          info: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, subgroupMinSize: info.subgroupMinSize, subgroupMaxSize: info.subgroupMaxSize },
          // Moved from GPUAdapter to GPUAdapterInfo in recent Chromium; read both.
          isFallbackAdapter: 'isFallbackAdapter' in info ? info.isFallbackAdapter : adapter.isFallbackAdapter,
          features: Array.from(adapter.features).sort(),
          limits,
          preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),
          wgslLanguageFeatures: navigator.gpu.wgslLanguageFeatures ? Array.from(navigator.gpu.wgslLanguageFeatures).sort() : null
        };
      }
    } catch (e) { out.webgpu = { error: String(e) }; }
  } else out.webgpu = 'absent';
  return out;
})()`

async function main(): Promise<void> {
  const engine = resolveTestEngine(process.argv[2])
  if (!existsSync(engine)) throw new Error(`No engine at ${engine} (set VGC_ENGINE_PATH)`)
  const page = await createLoopbackPage()
  const userDataDir = mkdtempSync(join(tmpdir(), 'vgc-gpu-probe-'))
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1000,700',
    `--vgc-webgl-vendor=${VENDOR}`,
    `--vgc-webgl-renderer=${RENDERER}`,
    '--vgc-seed=gpu-probe',
    ...(process.env.VGC_PROBE_HEADLESS === '1' ? ['--headless=new'] : [])
  ]
  let close: (() => Promise<void>) | undefined
  try {
    const session = await openNativePage(engine, args, page.url)
    close = session.close
    const result = (await session.conn.send(
      'Runtime.evaluate',
      { expression: PROBE, awaitPromise: true, returnByValue: true },
      session.sessionId
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    process.stdout.write(JSON.stringify(result.result?.value, null, 2) + '\n')
  } finally {
    await close?.()
    await page.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
