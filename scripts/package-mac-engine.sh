#!/bin/bash
set -euo pipefail

SRC="${1:-$HOME/vgc-chromium/src/out/vgc/Chromium.app}"
# Engine version is EXPLICIT: it names the zip and the app gates WebGPU spoofing on it
# (>= 0.1.101 means the engine carries vgc-webgpu-identity.patch). Never default it to
# the app version — that would satisfy the gate with any engine.
VER="${2:-}"
if [ -z "$VER" ]; then echo "Usage: $0 <Chromium.app> <engine-version e.g. 0.1.101> [needs VGC_CHROMIUM_SRC for the WebGPU check]" >&2; exit 1; fi
if [ -n "${VGC_CHROMIUM_SRC:-}" ] && ! grep -q VgcWebGpuIdentity "$VGC_CHROMIUM_SRC/third_party/blink/renderer/modules/webgpu/gpu_adapter.cc"; then
  echo "Engine tree $VGC_CHROMIUM_SRC lacks vgc-webgpu-identity.patch; refusing to package $VER" >&2; exit 1
fi
ARCH="$(uname -m)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
WORK="$(mktemp -d)"
STAGE="$WORK/VGC Core.app"
ZIP="$OUT/vgc-core-mac-$ARCH-$VER.zip"
IDENTITY="${MAC_DEVELOPER_ID:-}"
NOTARY_PROFILE="${VGC_NOTARY_PROFILE:-}"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ ! -d "$SRC" ]; then echo "Không thấy engine đã build: $SRC" >&2; exit 1; fi
if [ -z "$IDENTITY" ]; then echo "Thiếu MAC_DEVELOPER_ID (Developer ID Application)." >&2; exit 1; fi
if [ -z "$NOTARY_PROFILE" ]; then echo "Thiếu VGC_NOTARY_PROFILE cho xcrun notarytool." >&2; exit 1; fi

mkdir -p "$OUT"
cp -Rc "$SRC" "$STAGE"
find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '._*' -delete

PL=/usr/libexec/PlistBuddy
EXPECTED_ENGINE_VERSION="$(node -e "console.log(require('./src/shared/engine-release.json').chromeVersion)")"
ACTUAL_ENGINE_VERSION="$("$PL" -c 'Print :CFBundleShortVersionString' "$STAGE/Contents/Info.plist")"
if [ "$ACTUAL_ENGINE_VERSION" != "$EXPECTED_ENGINE_VERSION" ]; then
  echo "Engine $ACTUAL_ENGINE_VERSION không khớp manifest $EXPECTED_ENGINE_VERSION" >&2
  exit 1
fi
"$PL" -c "Set :CFBundleIdentifier com.vgcgroup.core" "$STAGE/Contents/Info.plist"
"$PL" -c "Set :CFBundleName VGC Core" "$STAGE/Contents/Info.plist" 2>/dev/null || true
"$PL" -c "Set :CFBundleDisplayName VGC Core" "$STAGE/Contents/Info.plist" 2>/dev/null || true

codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$STAGE"
codesign --verify --deep --strict --verbose=2 "$STAGE"
codesign -dv --verbose=4 "$STAGE" 2>&1 | grep -q 'Authority=Developer ID Application:'

SUBMIT_ZIP="$WORK/notarize.zip"
COPYFILE_DISABLE=1 ditto -c -k --keepParent "$STAGE" "$SUBMIT_ZIP"
xcrun notarytool submit "$SUBMIT_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$STAGE"
xcrun stapler validate "$STAGE"
spctl --assess --type execute --verbose=4 "$STAGE"

rm -f "$ZIP"
COPYFILE_DISABLE=1 ditto -c -k --keepParent "$STAGE" "$ZIP"
HASH="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
printf '%s  %s\n' "$HASH" "$(basename "$ZIP")" > "$ZIP.sha256"

echo "Engine macOS đã ký Developer ID, notarize và staple: $ZIP"
echo "SHA-256: $HASH"
