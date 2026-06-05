# VGC Browser

Antidetect browser & multi-account profile manager (GoLogin-style) — by **VGC Group**.

Each *profile* is a fully isolated browser identity: its own cookies/cache/storage
(`--user-data-dir`), its own proxy, and its own fingerprint (UA, WebGL, canvas,
timezone, …). The goal is for every profile to look like a distinct real device.

## Architecture (two parallel tracks)

| Track | What | Status |
|-------|------|--------|
| **App** (`src/`) | Electron + React profile manager | 🚧 in progress |
| **Engine** (`engine/`) | Patched Chromium fork "VGC Core" (Orbita-equivalent) | ⏳ Phase 5 |

```
src/
  main/      Electron main: profile lifecycle, engine spawn, IPC, storage
  preload/   contextBridge → window.vgc
  renderer/  React UI (profile list, create, run/stop)
  shared/    types + fingerprint generator (runtime-agnostic)
scripts/     download-engine.mjs (temporary ungoogled-chromium)
engine/      chromium/  (downloaded engine, gitignored)
```

## Roadmap

- **Phase 0** — Foundation: scaffold, profile model, launch isolated Chromium. ← *here*
- **Phase 1** — Core loop: CDP fingerprint injection (canvas/webgl/audio/webrtc), validate on browserleaks.
- **Phase 2** — Profile management: groups, tags, import/export, cookie import, consistent fingerprint generator.
- **Phase 3** — Proxy: HTTP/SOCKS5, auth via local relay, auto timezone/geo from IP, buy-proxy integration.
- **Phase 4** — Automation: local REST API + Selenium/Puppeteer/Playwright endpoints.
- **Phase 5** — Engine "VGC Core": Chromium fork + native fingerprint patches; swap out the temporary engine.
- **Phase 6** — Cloud + Team: auth, profile sync, roles/sharing.

## Dev

```powershell
npm install
npm run download-engine   # optional: fetch ungoogled-chromium (else falls back to Chrome/Edge)
npm run dev               # launch the app
npm run typecheck         # tsc --noEmit
npm run build             # production build
```

Engine resolution order: `VGC_ENGINE_PATH` env → `engine/chromium/chrome.exe` →
system Chrome → system Edge.

## Validation targets (for the engine track)

browserleaks.com · pixelscan.net · creepjs · iphey.com · bot.sannysoft.com
