# VGC Core — fingerprint patch specification

## Applied so far (committed as .patch files here — re-apply to a clean Chromium checkout)
- **`01-webgl-vendor-renderer.patch`** ✅ — WebGL `UNMASKED_VENDOR/RENDERER_WEBGL` read `--vgc-webgl-vendor` / `--vgc-webgl-renderer`. Verified: page-side WebGL returns the spoofed value (native, no JS tell).
- **`02-forward-vgc-switches.patch`** ✅ — `ChromeContentBrowserClient::AppendExtraCommandLineSwitches` forwards the `--vgc-*` switches to **child (renderer) processes**. REQUIRED: WebGL runs in the renderer; without forwarding the renderer never sees the switch and returns the real GPU.
- **`06-screen-native.patch`** ✅ VERIFIED — `Screen::width/height/avail*/colorDepth/pixelDepth` read `--vgc-screen=WxH` (+ `--vgc-color-depth`). Built + validated on M151: screen.width returns the spoofed value from a NATIVE getter (isNativeGetter=true, no JS override). Real git-apply-able diff. `vgc-screen`+`vgc-color-depth` added to kVgcSwitches (02). The native-mode guard auto-detects native screen (`__vgcScreenNative`) and drops its JS Screen getters; connection/client-rects stay JS (no native patch yet, so __vgcNative stays false).
- **`07-client-rects-native.patch`** 🟡 DRAFT — `Element::getBoundingClientRect` / `getClientRects` apply deterministic sub-pixel farbling seeded from the EXISTING `--vgc-seed` (no new switch). Mirrors the JS algorithm in `src/main/stealth-extra.ts`. Closes the `clientRectsNoise` vector natively. Authored by method name — build + validate before shipping.
- **`vgc-uach-chrome-brand.patch`** ✅ REQUIRED — `components/embedder_support/user_agent_utils.cc`. Reads `--vgc-ua-full-version` / `--vgc-ua-platform` / `--vgc-ua-platform-version` / `--vgc-ua-arch` / `--vgc-ua-bitness` for the UA client hints, forces the `"Google Chrome"` brand, and — critically — REMOVES the stock early-return that blanks UA-CH whenever a custom `--user-agent` is set (every VGC profile sets one). Without this patch `navigator.userAgentData.getHighEntropyValues()` returns EMPTY fullVersionList / platformVersion / architecture / bitness in NATIVE mode (there is no CDP to fill them), which real Chrome never does → an instant Cloudflare/creepjs tell. **Historically omitted from the build**, which is why shipped engines advertised empty UA-CH. Independent of `vgc-native-all.patch` (different file), so apply both.
- **`AppIcon.icon/`** — the VGC `.icon` source (macOS). NOTE: macOS 26 still prefers the compiled `Assets.car` AppIcon, so the build alone does NOT change the Dock icon. The reliable fix is applied at **package time** (`scripts/package-mac-engine.sh`): delete `CFBundleIconName` from `Info.plist` → macOS falls back to `CFBundleIconFile=app.icns`, which is the VGC logo.

> Apply order on a fresh `out/vgc` checkout: `git apply engine-src/patches/01-*.patch engine-src/patches/02-*.patch`, copy `AppIcon.icon` over `chrome/app/theme/chromium/mac/AppIcon.icon`, rebuild `chrome`, then `scripts/package-mac-engine.sh`.

---

Each profile launch passes `--vgc-*` switches (see `src/main/profile-manager.ts`).
These patches make Chromium **read those switches and override the value natively**,
so there is no JS-detectable tampering (the difference vs the Phase-1 CDP injection).

**How to read a switch** (in any of the .cc files below):
```cpp
#include "base/command_line.h"
// ...
const auto* cmd = base::CommandLine::ForCurrentProcess();
std::string v = cmd->GetSwitchValueASCII("vgc-webgl-vendor");   // etc.
if (!v.empty()) { /* use v instead of the real value */ }
```
Switch names (no leading `--` in the API): `vgc-webgl-vendor`, `vgc-webgl-renderer`,
`vgc-hardware-concurrency`, `vgc-device-memory`, `vgc-seed`.

> Paths are for Chromium ~149; exact lines drift per version — match by **method
> name**, not line number. Each row = one patch commit.

| Vector | File | Method / hook | What to do |
|---|---|---|---|
| **WebGL vendor/renderer** | `third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc` | `WebGLRenderingContextBase::getParameter` (and the unmasked path) | For `GL_VENDOR` (0x1F00), `GL_RENDERER` (0x1F01), `UNMASKED_VENDOR_WEBGL` (0x9245), `UNMASKED_RENDERER_WEBGL` (0x9246) → return `--vgc-webgl-vendor` / `--vgc-webgl-renderer` as a `WebGLString`. |
| **hardwareConcurrency** | `third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc` | `NavigatorConcurrentHardware::hardwareConcurrency()` | Return `atoi(--vgc-hardware-concurrency)` when set. |
| **deviceMemory** | `third_party/blink/renderer/core/frame/navigator_device_memory.cc` | `NavigatorDeviceMemory::deviceMemory()` | Return `--vgc-device-memory` (GB; Chrome caps to {0.25,0.5,1,2,4,8}). |
| **Canvas noise** | `third_party/blink/renderer/core/html/canvas/html_canvas_element.cc` (+ `modules/canvas/...` `getImageData`, and WebGL `readPixels`) | the pixel **readback** paths (`ToDataURLInternal`, `toBlob`, `getImageData`) | Perturb pixels by a deterministic ±1 seeded from `--vgc-seed` (mulberry32). Mirror the JS algorithm in `src/main/fingerprint-script.ts` so profiles stay stable. |
| **Audio noise** | `third_party/blink/renderer/modules/webaudio/audio_buffer.cc` (or `analyser_node.cc`) | `AudioBuffer::getChannelData` / `AnalyserNode::getFloatFrequencyData` | Add tiny seeded noise (`--vgc-seed ^ const`) on the read path. |
| **Fonts** | `third_party/blink/renderer/platform/fonts/font_cache.cc` / platform font enumeration | font availability lookup | Restrict detectable fonts to a per-OS allowlist (the app already generates one in `fingerprint.ts`). Hardest vector — schedule last. |
| **WebRTC IP** | `third_party/blink/renderer/modules/peerconnection/...` / webrtc port allocator | ICE candidate gathering | Only surface the proxy's public IP / use mDNS host candidates; never leak the real local IP. (App passes the proxy IP via the fingerprint; consider a `--vgc-webrtc-ip` switch.) |
| **navigator.platform** | `navigator_id.cc` | `NavigatorID::platform()` | Reads `--vgc-platform` (in `vgc-native-all.patch`). |
| **UA client hints** (brands / fullVersionList / platformVersion / arch / bitness) | `components/embedder_support/user_agent_utils.cc` | `GetUserAgentMetadata` + brand/platform/arch/bitness helpers | ✅ `vgc-uach-chrome-brand.patch`. NOT "handled by CDP" — that only covers CDP mode; NATIVE mode (the default) has no CDP, so this patch is REQUIRED or UA-CH is empty. |
| **Screen** | `third_party/blink/renderer/core/frame/screen.cc` | `Screen::width/height/availWidth/availHeight/availLeft/availTop/colorDepth/pixelDepth` | ✅ `06-screen-native.patch` — return `--vgc-screen=WxH` / `--vgc-color-depth`; avail offsets 0; avail height minus a taskbar inset. |
| **Client rects** | `third_party/blink/renderer/core/dom/element.cc` | `Element::getBoundingClientRect` / `getClientRects` | 🟡 `07-client-rects-native.patch` — deterministic sub-pixel offset seeded from `--vgc-seed` (reuse; no new switch). |

### JS layer (ships without a rebuild — CDP mode + native-mode guard extension)
The vectors below are spoofed in JS today (`src/main/stealth-extra.ts`, shared by
`fingerprint-script.ts` and `webrtc-guard.ts`) and verified by `npm run verify` (11/11):
client rects, `screen.availLeft/availTop`, `navigator.connection`, `mediaDevices` labels.
The 🟡 native patches above supersede the JS screen + client-rects spoofs once built — at
that point disable the JS duplicates on the native path (see each patch header) so native
and JS do not double-spoof.

## Branding (name + icon)
| Target | Change |
|---|---|
| `chrome/app/theme/chromium/BRANDING` | `PRODUCT_FULLNAME=VGC Browser`, `PRODUCT_SHORTNAME=VGC Browser`, company fields → VGC Group. |
| `chrome/app/theme/chromium/mac/app.icns` | replace with the VGC icon (use `resources/vgc.ico` → convert to `.icns`; or `iconutil` from a `.iconset`). |
| `chrome/app/theme/chromium/win/chromium.ico` (+ size PNGs) | replace with `resources/vgc.ico`. |
| product strings (`chrome/app/chromium_strings.grd`) | "Chromium" → "VGC Browser" where user-visible (window title, About). |

## Suggested order (incremental, each builds + validates on its own)
1. Branding (name + icon) — quick visible win, proves the build pipeline.
2. WebGL vendor/renderer — highest detector signal, easiest patch.
3. hardwareConcurrency + deviceMemory — trivial.
4. Canvas + Audio noise (seeded) — the spoof core.
5. WebRTC IP.
6. Fonts — hardest, last.

Validate after each on `creepjs` / `browserleaks` to confirm **no JS-override tells**.
