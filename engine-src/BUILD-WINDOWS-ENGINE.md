# VGC Core — Build the Windows engine (with cross-machine password/cookie sync)

This builds the **Windows** VGC Core engine from Chromium source with the same
fingerprint + **portable os_crypt key** patches as the macOS engine, so that **saved
passwords and cookies sync between Windows and macOS** (both engines derive the SAME
encryption key from `--vgc-crypt-secret`, so data encrypted on one machine decrypts
on the other).

> Do this **on the Windows machine**. It's a large build (~100 GB disk, 1–3 hours on
> a fast PC). You only redo it when the Chromium version is bumped or a patch changes.

Pinned Chromium version: **151.0.7902.0** (must match the macOS engine for the
fingerprint/UA to line up — check `chrome/VERSION` on the Mac build).

---

## 1. Prerequisites (Windows)

- Windows 10/11 x64, ~100 GB free disk, 16 GB+ RAM.
- **Visual Studio 2022** (Community is fine) with the **"Desktop development with
  C++"** workload + these individual components:
  - MSVC v143 x64/x86 build tools, Windows 11 SDK (10.0.22621 or newer),
    C++ ATL, C++ MFC, Debugging Tools for Windows.
- Set the env var so depot_tools uses your local VS (PowerShell, admin):
  ```
  setx DEPOT_TOOLS_WIN_TOOLCHAIN 0
  setx vs2022_install "C:\Program Files\Microsoft Visual Studio\2022\Community"
  ```
- **depot_tools**: download https://storage.googleapis.com/chrome-infra/depot_tools.zip,
  extract to `C:\src\depot_tools`, and add it to the FRONT of `PATH`.
- Git + Python 3 (depot_tools bundles them; just ensure `gclient` runs).

## 2. Fetch Chromium at the pinned version

```bat
mkdir C:\src\vgc-chromium && cd C:\src\vgc-chromium
fetch --no-history chromium
cd src
git fetch --tags
git checkout 151.0.7902.0
gclient sync -D --no-history
```

(If `fetch` already pulled a different version, `git checkout 151.0.7902.0` then
`gclient sync -D` re-syncs deps to that tag.)

## 3. Apply the VGC patches

Copy the `engine-src/patches/` folder from this repo to the Windows machine, then
from `C:\src\vgc-chromium\src` apply the **single combined patch** (it supersedes
the old `01`–`05` files — it contains ALL of them plus the newer features):

```bat
git apply --3way path\to\patches\vgc-native-all.patch
```

`--3way` lets git auto-merge minor context drift. If a hunk still fails, apply the
old individual `01`–`05` patches for the os_crypt/switch parts, then hand-apply the
newer files listed below.

**What `vgc-native-all.patch` contains (all on 151.0.7902.0):**

| Area | Files | Works on Windows? |
|---|---|---|
| Portable os_crypt key (password/cookie sync) | `dpapi_key_provider.cc`, `browser_process_impl.cc` (disable App-Bound), `keychain_password_mac.mm` (mac, inert) | ✅ (dpapi + app-bound are the Windows path) |
| Forward `--vgc-*` switches to child procs | `chrome_content_browser_client.cc`, `browser_process_impl.cc` | ✅ (required) |
| Native fingerprint (platform/hw/deviceMemory/timezone) | `navigator*.cc`, `timezone_controller.cc` | ✅ |
| Canvas/WebGL/Audio farbling (per-profile, `--vgc-seed`) | `base_rendering_context_2d.cc`, `image_data_buffer.cc`, `webgl_rendering_context_base.cc`, `offline_audio_context.cc` | ✅ |
| WebGL UNMASKED vendor/renderer spoof | `webgl_rendering_context_base.cc` | ✅ |
| Google **Translate** without an API key | `translate_manager.cc` | ✅ |
| **Profile-name badge** (bottom-left of the window, `--vgc-profile-name`) | `contents_web_view.cc/.h` | ✅ |
| Profile name in the **window title** (taskbar / Alt-Tab) | `window_metadata_controller.cc` | ✅ |
| Profile name painted on the **macOS Dock icon** | `app_controller_mac.mm` | ❌ macOS-only (Windows has no Dock — the taskbar uses the window title above instead; the exe icon is the VGC logo via rcedit, step 6b) |

So on Windows you get the same fingerprint + translate + **the bottom-left name
badge** + the name in the **taskbar/Alt-Tab title** + the **VGC logo** on the exe.
The Mac-only Dock composite simply doesn't compile into the Windows build (harmless).

What 02/04/05 do for password sync:
- **04** patches `DPAPIKeyProvider` so when `--vgc-crypt-secret=S` is set it derives
  the key `PBKDF2-HMAC-SHA1(S, "saltysalt", 1003)` → 16-byte **AES-128-CBC**, tag
  `"v10"` — byte-for-byte identical to the macOS `keychain_key_provider`.
- **05** stops registering Windows **App-Bound encryption** when the switch is set,
  so the portable DPAPI provider is the primary encryptor (App-Bound would otherwise
  bind data to that one PC and break cross-machine decryption).
- **02** forwards `--vgc-crypt-secret` (and the `--vgc-*` fingerprint switches) to
  child processes (the network service decrypts cookies).

## 4. Configure the build (args.gn)

```bat
gn gen out\vgc
```
Then edit `out\vgc\args.gn` to (same as `engine-src/args.gn` but **x64**):

```gn
is_debug = false
is_official_build = true
chrome_pgo_phase = 0
target_cpu = "x64"
symbol_level = 0
blink_symbol_level = 0
is_component_build = false
proprietary_codecs = true
ffmpeg_branding = "Chrome"
enable_nacl = false
dcheck_always_on = false
```

Re-run `gn gen out\vgc` after editing.

## 5. Build

```bat
autoninja -C out\vgc chrome
```

Output lands in `out\vgc\` (`chrome.exe` + the `*.dll`, `*.pak`, `locales\`, etc.).

## 6. Package the engine zip

The app downloads the Windows engine from `settings.engineUrl` and extracts it so
that **`chrome.exe` is at the root** of `userData/engine/chromium/` (see
`src/main/engine-download.ts` → `downloadedEngineExe()`). So zip the **contents** of
`out\vgc` flat (not a parent folder). From `out\vgc`:

```powershell
# keep it lean — ship the runtime files, skip build junk
$dst = "C:\src\vgc-core-win"
robocopy . $dst /E /XF *.pdb *.ninja *.o *.lib /XD obj gen
Compress-Archive -Path "$dst\*" -DestinationPath "C:\src\vgc-core-win-x64-149.zip" -Force
```

> Name it `vgc-core-win-x64-<ver>.zip`. Verify the zip has `chrome.exe` at its ROOT
> (open it — the first entries should be `chrome.exe`, `*.dll`, `locales\`…). If a
> parent folder wraps them, the install will fail to find `chrome.exe`.

### 6b. VGC logo on the exe (the "cùng logo như này" part)

The launched browser's taskbar/exe icon is set to the VGC logo by **rcedit**, NOT a
source patch — so it's independent of the Chromium build. `scripts/brand-engine.mjs`
runs during `npm run dist` (and re-applies at install) and stamps
`resources/vgc.ico` (the blue-teal VGC sphere, 256px) onto `chrome.exe` +
`chrome_proxy.exe`. To brand the freshly-built engine before zipping, from the repo:

```bat
:: put the built engine at engine\chromium\chrome.exe first, then:
node scripts\brand-engine.mjs
```

Verify: right-click `chrome.exe` → Properties → the icon is the VGC sphere. (The
bottom-left name **badge** and the taskbar-title name come from the source patch,
so they're already in the build — no rcedit needed for those.)

## 7. Upload + point the app at it

Upload to the same host as the Mac engine (`vgcbrowser.com/dl/`), then set the
Windows engine URL. In `src/main/settings.ts`, `engineUrl` currently points at the
old engine — update it to the new build, e.g.:
```
engineUrl: 'https://vgcbrowser.com/dl/vgc-core-win-x64-149.zip'
```
(Upload with the same `sftp reput` method used for the Mac engine — see the deploy
notes — large files need a resumable upload.)

## 8. Test the cross-machine password/cookie sync

Both machines must run a **patched** engine (Windows built here + the Mac VGC Core)
**and** app **v0.1.56+** (which passes `--vgc-crypt-secret`).

1. Sign into the SAME cloud account on both machines.
2. On machine A: open a profile, log into a site **and save the password** in
   Chrome's password manager, then **close the profile** (uploads the session).
3. On machine B: open the **same** profile → you should be logged in **and** the
   saved password appears in the engine's password manager.

### Migration note (one-time)
Switching a profile to the portable key means data encrypted under the OLD
machine-bound key can't be read with the new key. Existing saved passwords/cookies in
a profile are effectively reset the first time it opens with `--vgc-crypt-secret`;
re-save them once and they sync from then on. (Cookies still also sync via the
plaintext CDP path, so login persistence is unaffected.)

### If passwords still don't cross over
The async os_crypt path is the primary one in Chromium 151, but if some data is still
written via the **legacy sync** `OSCrypt` (`components/os_crypt/sync/os_crypt_win.cc`),
that file also needs the same `--vgc-crypt-secret` branch (derive PBKDF2→AES-128-CBC,
prefix `"v10"`). Ping me with what `chrome://password-manager` shows and I'll add the
sync-path patch.
