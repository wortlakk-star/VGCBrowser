# Build VGC Core on Windows

The authoritative Chromium version is `src/shared/engine-release.json`. The app,
release scripts, runtime verifier, and fingerprint UA all read that same manifest.
Do not copy a version number into another source file.

VGC Core deliberately uses Chromium's normal machine-bound os_crypt key. Never add
`--vgc-crypt-secret` or `VGC_CRYPT_SECRET`. Cross-machine cookies and saved passwords
are moved by the app's authenticated password bridge, encrypted with the account
secret in cloud storage, then re-encrypted with the destination machine's local key.

## Prerequisites

- Windows 10/11 x64, Visual Studio 2022 with Desktop C++ and a current Windows SDK.
- At least 100 GB free disk and 16 GB RAM.
- `depot_tools` at the front of `PATH`.
- `DEPOT_TOOLS_WIN_TOOLCHAIN=0` when using the locally installed Visual Studio.

## Checkout

Read `chromeVersion` from the manifest, then check out that exact Chromium tag:

```powershell
$release = Get-Content .\src\shared\engine-release.json | ConvertFrom-Json
$version = $release.chromeVersion

mkdir C:\src\vgc-chromium
cd C:\src\vgc-chromium
fetch --no-history chromium
cd src
git fetch --tags
git checkout $version
gclient sync -D --no-history
gclient runhooks
```

Keep local work in a branch. Do not use a reset script on a dirty Chromium tree.

## Apply the patches

Copy this repository beside the Chromium checkout, then apply both authoritative
patches:

```powershell
git apply --3way C:\path\VGCBrowser\engine-src\patches\vgc-native-all.patch
git apply --3way C:\path\VGCBrowser\engine-src\patches\vgc-uach-chrome-brand.patch
```

`vgc-native-all.patch` contains the native navigator, worker, language, screen,
timezone, heap, canvas, WebGL, audio, client-rect, font, media-label, voice, and
profile-label behavior. It also keeps canvas crop/toDataURL/toBlob readbacks
idempotent and prevents the private CDP pipe from surfacing as `webdriver=true`.

`vgc-uach-chrome-brand.patch` provides coherent UA Client Hints, including platform,
architecture, bitness, full version, and the Google Chrome brand.

Neither patch modifies os_crypt.

## Configure and build

Generate `out\vgc`, then copy the settings from `engine-src\args.gn` and use x64:

```powershell
gn gen out\vgc
notepad out\vgc\args.gn
gn gen out\vgc
autoninja -C out\vgc chrome
```

The runtime must have `chrome.exe` and `chrome.dll` at the package root. Exclude
build artifacts such as `obj`, `gen`, PDBs, Ninja files, and static libraries.

## Verify before publishing

Run the native test against the built executable:

```powershell
cd C:\path\VGCBrowser
npm run verify:engine -- C:\src\vgc-chromium\src\out\vgc\chrome.exe
```

The test uses a private CDP pipe and loopback page. It checks UA/UA-CH, workers,
screen/media queries, timezone, WebGL, canvas crop and encoded surfaces, audio,
client rects, native descriptors, heap coherence, and `navigator.webdriver`.

Before release:

1. Confirm `ProductVersion` exactly matches `engine-release.json`.
2. Zip runtime contents with `chrome.exe` at the archive root.
3. Compute SHA-256 for the ZIP, `chrome.exe`, and `chrome.dll`; pin all three in the
   release manifest/settings.
4. For an unsigned release, set `VGC_ALLOW_UNSIGNED_BUILD=1`; the pipeline requires
   the app, `chrome.exe`, and `chrome.dll` all to report `NotSigned`.
5. For a signed release, leave unsigned mode disabled and set
   `VGC_WINDOWS_SIGNER_SUBJECT`; every executable must have a valid matching signature.

Both modes fail closed when the pinned hash or exact Chromium version is missing or
mismatched. Never mix signed and unsigned files in one release.
