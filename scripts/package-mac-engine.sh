#!/bin/bash
# ── VGC Browser — package the built VGC Core engine for distribution (macOS) ──
# Takes the freshly-built Chromium (engine-src/BUILD.md output) and produces a
# distributable engine: brands it (bundle id + name), ad-hoc signs it (so other
# Macs can launch it without an Apple cert), and zips it.
#
#   bash scripts/package-mac-engine.sh [path/to/Chromium.app] [version]
#
# Default source: ~/vgc-chromium/src/out/vgc/Chromium.app
# Output: release/vgc-core-mac-<arch>-<version>.zip  (upload to vgcbrowser.com/dl)
#
# Install side (engine-download.ts on darwin): download + unzip into
# userData/engine/ as "VGC Core.app", then `codesign --force --deep --sign -` is a
# no-op if already ad-hoc signed. macVgcCoreEngine() then picks it up.
set -e

SRC="${1:-$HOME/vgc-chromium/src/out/vgc/Chromium.app}"
VER="${2:-$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo dev)}"
ARCH="$(uname -m)"   # arm64 | x86_64
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
STAGE="$(mktemp -d)/VGC Core.app"

if [ ! -d "$SRC" ]; then echo "✗ Không thấy engine đã build: $SRC"; exit 1; fi
mkdir -p "$OUT"

echo "→ Sao chép engine (clonefile)…"
mkdir -p "$(dirname "$STAGE")"
cp -Rc "$SRC" "$STAGE"

echo "→ Branding (bundle id + tên)…"
PL=/usr/libexec/PlistBuddy
"$PL" -c "Set :CFBundleIdentifier com.vgcgroup.core" "$STAGE/Contents/Info.plist"
"$PL" -c "Set :CFBundleName VGC Browser" "$STAGE/Contents/Info.plist" 2>/dev/null || true
"$PL" -c "Set :CFBundleDisplayName VGC Browser" "$STAGE/Contents/Info.plist" 2>/dev/null || true
# macOS 26 prefers the Assets.car AppIcon (still the stock Chromium icon — the new
# `.icon` format resisted our source edit). Removing CFBundleIconName forces the
# legacy CFBundleIconFile=app.icns, which IS the VGC logo → VGC icon on the Dock.
"$PL" -c "Delete :CFBundleIconName" "$STAGE/Contents/Info.plist" 2>/dev/null || true

echo "→ Ad-hoc sign (để Mac khác mở được không cần cert Apple)…"
codesign --force --deep --sign - "$STAGE" 2>&1 | tail -1 || true

ZIP="$OUT/vgc-core-mac-$ARCH-$VER.zip"
echo "→ Nén → $(basename "$ZIP")…"
( cd "$(dirname "$STAGE")" && ditto -c -k --keepParent "VGC Core.app" "$ZIP" )

echo "✓ Xong: $ZIP  ($(du -h "$ZIP" | cut -f1))"
echo "  Tải lên: vgcbrowser.com/dl/$(basename "$ZIP")"
echo "  Đặt settings.engineUrlMac = https://vgcbrowser.com/dl/$(basename "$ZIP")"
rm -rf "$(dirname "$STAGE")"
