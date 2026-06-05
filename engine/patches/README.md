# VGC Core — Chromium fingerprint patches

Native (C++) fingerprint spoofing for the "VGC Core" engine. Unlike the app's
CDP/JS injection (Phase 1, detectable by lie-detectors like creepjs), these
values are returned by the engine itself, so JS introspection can't tell they're
spoofed.

## How it works
The browser is launched (per profile) with switches the renderer reads:

| Switch | Spoofs | Source file patched |
|--------|--------|---------------------|
| `--vgc-hardware-concurrency=<n>` | `navigator.hardwareConcurrency` | `core/frame/navigator_concurrent_hardware.cc` |
| `--vgc-device-memory=<gb>` | `navigator.deviceMemory` | `core/frame/navigator_device_memory.cc` |
| `--vgc-webgl-vendor=<s>` | `UNMASKED_VENDOR_WEBGL` | `modules/webgl/webgl_rendering_context_base.cc` |
| `--vgc-webgl-renderer=<s>` | `UNMASKED_RENDERER_WEBGL` | same |

These switches are also added to `content/.../render_process_host_impl.cc`
`kSwitchNames[]` so the browser process forwards them to renderer processes.

The app already passes these switches on launch (see `profile-manager.ts`), so
stock Chrome ignores them and VGC Core honors them — same code path either way.

## Build
```powershell
# 1. (once) sync source — D:\chromium\sync-resume.ps1
# 2. apply patches
powershell -File C:\VGCBrowser\engine\patches\apply-patches.ps1
# 3. configure + build  (also runs apply-patches)
powershell -File D:\chromium\build-engine.ps1
# → D:\chromium\src\out\Default\chrome.exe
```
Point the app at it: set `VGC_ENGINE_PATH=D:\chromium\src\out\Default\chrome.exe`
(or copy the build into `engine/chromium/`).

## Roadmap (more native patches)
- Canvas readback noise (seeded) — `HTMLCanvasElement::toDataURL`, `BaseRenderingContext2D::getImageData`
- AudioContext noise — `AudioBuffer`/`AnalyserNode`
- `navigator.platform` / userAgentData at engine level
- WebGL parameter masking (precision, extensions list)
- Per-profile seed plumbed via a single `--vgc-fingerprint=<base64 json>` switch

> First patch set is intentionally small to prove the patch→build→spoof pipeline.
> Each new patch is verified by building and checking creepjs/pixelscan.
