# VGC Core patch artifacts

Only these two source patches are authoritative:

- `vgc-native-all.patch`: native fingerprint surfaces, worker coherence, per-profile
  farbling, privacy behavior, and browser UI profile labels.
- `vgc-uach-chrome-brand.patch`: UA Client Hints version/platform/architecture and
  coherent Chrome brand metadata.

Apply both to the Chromium tag named by `src/shared/engine-release.json`.

```bash
git apply --3way /path/VGCBrowser/engine-src/patches/vgc-native-all.patch
git apply --3way /path/VGCBrowser/engine-src/patches/vgc-uach-chrome-brand.patch
```

The combined patch currently covers:

- main-window and WorkerNavigator platform, CPU, memory, and languages;
- UA, UA-CH, timezone, screen, media-query, and heap coherence;
- native WebGL identity and bounded readback farbling;
- idempotent canvas `getImageData`, crop, `toDataURL`, and `toBlob` behavior;
- native offline-audio and client-rect farbling;
- font allowlisting, media-device label privacy, and voice-list subsetting;
- private CDP automation without a `navigator.webdriver` signal;
- VGC profile labels in browser chrome.

The patches must not alter Chromium os_crypt and must not introduce
`vgc-crypt-secret` or `VGC_CRYPT_SECRET`. Credentials move between machines through
the app's account-secret-encrypted bridge, while each engine retains its local
machine-bound key.

`AppIcon.icon/` contains the macOS branding source. Packaging remains responsible
for selecting and signing the final platform icon assets.

After updating source, regenerate the patch artifacts from the reviewed Chromium
diff and verify that each is exactly reversible against the built tree:

```bash
git apply --reverse --check /path/VGCBrowser/engine-src/patches/vgc-native-all.patch
git apply --reverse --check /path/VGCBrowser/engine-src/patches/vgc-uach-chrome-brand.patch
```

Then rebuild and run `npm run verify`, `verify:tostring`, `verify:deep`, and
`verify:correlation` before publishing.
