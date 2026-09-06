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
# Arch token as the app's engine URL regex / arch guard expect it: arm64 | x64.
ARCH="${VGC_ENGINE_ARCH:-$(uname -m)}"
case "$ARCH" in x86_64|intel) ARCH=x64 ;; esac
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
# Without a Developer ID the engine is AD-HOC signed. The app only accepts an ad-hoc
# engine when the app itself is ad-hoc signed (engine-download.ts verifyMacBundle), which
# is how the current unsigned builds ship; a Developer ID app must ship a notarized engine.
ADHOC=0
if [ -z "$IDENTITY" ]; then
  ADHOC=1
  echo "MAC_DEVELOPER_ID không có → ký ad-hoc (chỉ chạy được với app cũng ký ad-hoc)." >&2
elif [ -z "$NOTARY_PROFILE" ]; then
  echo "Thiếu VGC_NOTARY_PROFILE cho xcrun notarytool." >&2; exit 1
fi

mkdir -p "$OUT"
cp -Rc "$SRC" "$STAGE"
find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '._*' -delete

PL=/usr/libexec/PlistBuddy
EXPECTED_ENGINE_VERSION="$(VGC_ROOT="$ROOT" node -e "console.log(require(process.env.VGC_ROOT + '/src/shared/engine-release.json').chromeVersion)")"
ACTUAL_ENGINE_VERSION="$("$PL" -c 'Print :CFBundleShortVersionString' "$STAGE/Contents/Info.plist")"
if [ "$ACTUAL_ENGINE_VERSION" != "$EXPECTED_ENGINE_VERSION" ]; then
  echo "Engine $ACTUAL_ENGINE_VERSION không khớp manifest $EXPECTED_ENGINE_VERSION" >&2
  exit 1
fi
"$PL" -c "Set :CFBundleIdentifier com.vgcgroup.core" "$STAGE/Contents/Info.plist"
"$PL" -c "Set :CFBundleName VGC Core" "$STAGE/Contents/Info.plist" 2>/dev/null || true
"$PL" -c "Set :CFBundleDisplayName VGC Core" "$STAGE/Contents/Info.plist" 2>/dev/null || true

if [ "$ADHOC" = 1 ]; then
  codesign --force --deep --sign - "$STAGE"
  codesign --verify --deep --strict --verbose=2 "$STAGE"
  # Capture BEFORE grepping: `codesign -dv | grep -q` races grep's early exit against
  # codesign still writing — grep -q closes the pipe on its first match while codesign
  # keeps producing output, so codesign dies of SIGPIPE (141) and, under pipefail, that
  # 141 (not grep's 0) becomes the pipeline's exit status and kills the whole script even
  # though the check itself matched. Capturing into a variable first lets codesign exit
  # normally before grep ever runs.
  SIGN_INFO="$(codesign -dv --verbose=4 "$STAGE" 2>&1)"
  echo "$SIGN_INFO" | grep -q 'Signature=adhoc'
else
  # Hardened runtime, signed INSIDE-OUT with Chromium's own per-helper entitlements: a
  # single --deep pass would give the Renderer/GPU helpers no entitlements, and under the
  # hardened runtime they then cannot JIT (V8) or map GPU memory. Mirrors
  # chrome/installer/mac/signing/parts.py.
  ENT="${VGC_CHROMIUM_SRC:-}/chrome/app"
  [ -f "$ENT/helper-renderer-entitlements.plist" ] || { echo "Cần VGC_CHROMIUM_SRC trỏ tới cây Chromium (để lấy entitlements của helper)." >&2; exit 1; }
  sign() { codesign --force --options runtime --timestamp --sign "$IDENTITY" "$@"; }
  FW="$STAGE/Contents/Frameworks/Chromium Framework.framework"
  FWV="$(find "$FW/Versions" -mindepth 1 -maxdepth 1 -type d ! -name Current | head -1)"
  find "$FWV/Libraries" -name '*.dylib' -print0 2>/dev/null | xargs -0 -n1 codesign --force --options runtime --timestamp --sign "$IDENTITY"
  for helper in "$FWV/Helpers/"*.app; do
    case "$(basename "$helper")" in
      *"(Renderer)"*) sign --entitlements "$ENT/helper-renderer-entitlements.plist" "$helper" ;;
      *"(GPU)"*) sign --entitlements "$ENT/helper-gpu-entitlements.plist" "$helper" ;;
      *"(Plugin)"*) sign --entitlements "$ENT/helper-plugin-entitlements.plist" "$helper" ;;
      *) sign "$helper" ;;
    esac
  done
  for bin in "$FWV/Helpers/"*; do [ -f "$bin" ] && [ -x "$bin" ] && sign "$bin"; done
  find "$FWV/XPCServices" -name '*.xpc' -maxdepth 1 -print0 2>/dev/null | xargs -0 -n1 codesign --force --options runtime --timestamp --sign "$IDENTITY"
  sign "$FWV"
  sign "$FW"
  sign --entitlements "$ENT/app-entitlements.plist" "$STAGE"
  codesign --verify --deep --strict --verbose=2 "$STAGE"
  # Same SIGPIPE-under-pipefail hazard as the ad-hoc check above — capture first.
  SIGN_INFO="$(codesign -dv --verbose=4 "$STAGE" 2>&1)"
  echo "$SIGN_INFO" | grep -q 'Authority=Developer ID Application:'

  SUBMIT_ZIP="$WORK/notarize.zip"
  COPYFILE_DISABLE=1 ditto -c -k --keepParent "$STAGE" "$SUBMIT_ZIP"
  xcrun notarytool submit "$SUBMIT_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$STAGE"
  xcrun stapler validate "$STAGE"
  spctl --assess --type execute --verbose=4 "$STAGE"
fi

rm -f "$ZIP"
COPYFILE_DISABLE=1 ditto -c -k --keepParent "$STAGE" "$ZIP"
HASH="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
printf '%s  %s\n' "$HASH" "$(basename "$ZIP")" > "$ZIP.sha256"

if [ "$ADHOC" = 1 ]; then
  echo "Engine macOS đã ký ad-hoc: $ZIP"
else
  echo "Engine macOS đã ký Developer ID, notarize và staple: $ZIP"
fi
echo "SHA-256: $HASH"
