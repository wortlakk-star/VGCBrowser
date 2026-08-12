# VGC Core build overview

VGC Core is the patched Chromium runtime used by VGC Browser. Fingerprint values are
implemented in Blink/Chromium and supplied through `--vgc-*` switches; the app does
not inject fingerprint JavaScript into pages.

## Single version source

`src/shared/engine-release.json` is authoritative for the Chromium version. It is
consumed by fingerprint generation, engine download verification, packaging, and
code-signing hooks. A build whose executable version differs from this manifest must
not ship.

## Source and patches

1. Fetch Chromium and check out the exact `chromeVersion` tag.
2. Run `gclient sync -D --no-history` and `gclient runhooks`.
3. Apply both files in `engine-src/patches/`:
   - `vgc-native-all.patch`
   - `vgc-uach-chrome-brand.patch`
4. Apply platform branding assets separately.
5. Generate `out/vgc` with `engine-src/args.gn` and the target CPU.
6. Build with `autoninja -C out/vgc chrome`.

The engine must keep the platform's normal machine-bound os_crypt implementation.
Cross-machine credentials are handled by the app bridge; portable browser keys are
forbidden because they invalidate existing local cookies and weaken isolation.

## Package and provenance

- Windows ZIP: `chrome.exe` and `chrome.dll` at the archive root. Pin the archive and
  both binary SHA-256 values. Release either fully signed by one publisher or explicitly
  fully unsigned.
- macOS ZIP: the complete Chromium app bundle, signed by the same Team ID as the host
  app. `scripts/package-mac-engine.sh` validates the version before signing.
- Runtime installation validates archive paths, size limits, hash, configured signing
  mode, and exact product version before accepting an engine.
- Release builds fail when required hash, version, or signing-mode metadata is unavailable.

## Required verification

From the app repository run:

```bash
npm run typecheck
npm run verify
npm run verify:tostring
npm run verify:deep
npm run verify:correlation
npm run build
```

The engine test and advanced audits use CDP pipe plus a local loopback page. They do
not expose a DevTools TCP endpoint or depend on a public test website.

When rebasing to a new Chromium release, regenerate both patch artifacts from the
reviewed source diff, build on every target OS, and repeat the complete verification.
