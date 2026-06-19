# VGC Core — Building the antidetect Chromium engine

This is the **blueprint** for VGC Core: a Chromium fork that applies the per-profile
fingerprint at the **C++ level** (canvas/WebGL/audio/fonts/navigator) by reading the
`--vgc-*` command-line switches the app already passes, plus **VGC branding** (name +
icon). It replaces the temporary `ungoogled-chromium` engine (the current `engine/`
binary), which ignores those switches — see `scripts/download-engine.mjs`.

> ⚠️ This is a large, ongoing project (hours per build, weeks to develop the patches,
> re-applied every Chromium version). It is what GoLogin's "Orbita" / Multilogin's
> "Mimic" engineering teams do full-time. Treat it as a real product track, not a
> one-shot task.

The switches the app passes (see `src/main/profile-manager.ts`):
`--vgc-hardware-concurrency`, `--vgc-device-memory`, `--vgc-webgl-vendor`,
`--vgc-webgl-renderer`, `--vgc-seed`. The patches below make Chromium honor them.

---

## 0. Pin the version
The app pins **Chrome 149** (`src/shared/fingerprint.ts` → `CHROME_BUILDS`). Build the
matching Chromium release tag so the claimed UA can't be caught lying via feature
checks. Find the exact tag at https://chromiumdash.appspot.com/releases (e.g.
`149.0.7827.x`).

## 1. Machine requirements
- **macOS**: Apple Silicon or Intel Mac, **≥16 GB RAM (32 recommended)**, **~100 GB
  free disk**, Xcode + Command Line Tools (`xcode-select --install`), Python 3, Git.
- **Windows**: VS 2022 (Desktop C++ workload) + Win 11 SDK, `DEPOT_TOOLS_WIN_TOOLCHAIN=0`.
- First build: **4–10+ hours**. Incremental builds after a patch: minutes to ~1 hour.

## 2. depot_tools + source
```bash
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$PWD/depot_tools:$PATH"          # put depot_tools FIRST on PATH

mkdir chromium && cd chromium
fetch --no-history chromium                    # ~30–50 GB
cd src
git checkout refs/tags/149.0.7827.0            # <- the pinned tag
gclient sync -D --no-history                    # sync deps to that tag
gclient runhooks
```

## 3. Apply the VGC patches
See **`patches/README.md`** for the exact files/methods to patch:
- **Branding** → product name "VGC Browser" + the VGC icon (`app.icns` / `.ico`).
- **Fingerprint** → read each `--vgc-*` switch and override the value at the C++ level.

Keep each change as a `git` commit (or a `.patch` file under `patches/`) so it
re-applies cleanly when you rebase onto the next Chromium tag.

## 4. Configure the build
```bash
gn gen out/vgc --args="$(cat ../../engine-src/args.gn | tr '\n' ' ')"
# or copy engine-src/args.gn to out/vgc/args.gn, then: gn gen out/vgc
```

## 5. Build
```bash
autoninja -C out/vgc chrome
```
Output:
- **macOS** → `out/vgc/Chromium.app` (renamed to `VGC Browser.app` by the BRANDING patch).
- **Windows** → `out/vgc/chrome.exe` + DLLs/PAKs.

## 6. Package as the engine
Zip the runtime files the app expects:
- **Windows**: `chrome.exe` + `*.dll` + `*.pak` + `locales/` + `resources/` +
  `icudtl.dat` + `v8_context_snapshot.bin` + `snapshot_blob.bin` → `vgc-core-<ver>.zip`
  (chrome.exe at the ZIP root — see `scripts/fetch-engine.mjs`).
- **macOS**: zip `VGC Browser.app` → host it, and add a Mac branch to the engine
  resolver (`src/main/engine-download.ts` currently treats non-win32 as "use system
  Chrome"; point it at the downloaded VGC Core app instead).

Host at `settings.engineUrl` (`https://vgcbrowser.com/dl/vgc-core-<ver>.zip`) +
a Mac URL. The app downloads + extracts on first launch.

## 7. Wire the app
- `src/main/settings.ts` → add `engineUrlMac` (the Mac VGC Core zip).
- `src/main/engine-download.ts` → on darwin, download/extract the Mac VGC Core and
  return its binary instead of system Chrome.
- macOS only: the built app is unsigned → **ad-hoc sign** it after extract
  (`codesign --force --deep --sign - "VGC Browser.app"`) so Gatekeeper allows launch,
  and it keeps CDP working (it's a *separate* Chromium, not system Chrome — that's why
  the clone-Chrome approach failed: cloning `com.google.Chrome` relaunches to the
  system copy and `--remote-debugging-port` is lost).

## 8. Validate
Open a profile and check: `browserleaks.com`, `pixelscan.net`, `creepjs`,
`iphey.com`, `bot.sannysoft.com`. The native values (WebGL/canvas/audio) should match
the profile fingerprint with **no JS-override tells** (the whole point vs Phase 1).

## 9. Maintenance
Each Chromium release: `git rebase` your patches onto the new tag, fix any rejects,
rebuild, re-validate. Budget recurring effort for this.
