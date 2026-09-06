#!/bin/bash
# Build VGC Core for macOS from the pinned Chromium tag with the three VGC patches and
# package it as release/vgc-core-mac-<arch>-<version>.zip — one command on a Mac.
#
#   engine-src/build-mac-engine.sh                 # ~/vgc-chromium, engine 0.1.101
#   engine-src/build-mac-engine.sh ~/work 0.1.101  # custom work dir / version
#
# Needs: full Xcode (not only the Command Line Tools), ~120 GB free disk, Node.js, git.
# A fresh checkout is ~25 GB and the build takes 3–8 hours depending on the Mac; the
# script is resumable — run it again and it continues from the last finished step.
# Signing: with MAC_DEVELOPER_ID (+ VGC_NOTARY_PROFILE) set the engine is Developer ID
# signed and notarized; without them it is ad-hoc signed, which the app accepts as long
# as the app itself is ad-hoc signed too (the current unsigned builds).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$HOME/vgc-chromium}"
VER="${2:-0.1.101}"
TAG="$(node -e "console.log(require('$REPO/src/shared/engine-release.json').chromeVersion)")"
case "$(uname -m)" in
  arm64) CPU=arm64 ;;
  x86_64) CPU=x64 ;;
  *) echo "Unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
JOBS="${VGC_BUILD_JOBS:-}"

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "Checking the toolchain"
[ "$(uname -s)" = Darwin ] || { echo "Run this on macOS." >&2; exit 1; }
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Full Xcode is required (App Store → Xcode, then: sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept)." >&2
  exit 1
fi
# Chromium 151 needs the macOS 15 SDK (Xcode 16+); with an older Xcode gn gen fails
# ~40 minutes in with an opaque find_sdk.py error, so refuse up front.
sdk_ver="$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)"
if [ "${sdk_ver%%.*}" -lt 15 ]; then
  echo "macOS SDK $sdk_ver is too old: Chromium $TAG needs SDK 15+ (Xcode 16 or newer, macOS 14.5+)." >&2
  exit 1
fi
echo "Xcode $(xcodebuild -version | head -1), macOS SDK $sdk_ver"
command -v node >/dev/null || { echo "Node.js is required (https://nodejs.org)." >&2; exit 1; }
command -v git >/dev/null || { echo "git is required." >&2; exit 1; }
avail_gb=$(( $(df -k "$HOME" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$avail_gb" -ge 100 ] || echo "WARNING: only ${avail_gb} GB free; Chromium needs ~120 GB." >&2
echo "Chromium $TAG, target_cpu=$CPU, engine version $VER, work dir $WORK"

step "depot_tools"
mkdir -p "$WORK"
if [ ! -d "$WORK/depot_tools" ]; then
  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$WORK/depot_tools"
fi
export PATH="$WORK/depot_tools:$PATH"
# Bootstrap depot_tools' own python/cipd ONCE (gn and autoninja need it), then pin it so
# a later run does not silently move to a newer depot_tools mid-build.
if [ ! -f "$WORK/depot_tools/python3_bin_reldir.txt" ]; then
  "$WORK/depot_tools/ensure_bootstrap"
fi
export DEPOT_TOOLS_UPDATE=0

step "Chromium source $TAG (no history)"
cd "$WORK"
if [ ! -f .gclient ]; then
  cat > .gclient <<EOF
solutions = [
  {
    "name": "src",
    "url": "https://chromium.googlesource.com/chromium/src.git",
    "managed": False,
    "custom_deps": {},
    "custom_vars": {"checkout_pgo_profiles": False},
  },
]
target_os = ["mac"]
EOF
fi
if [ ! -d src/.git ]; then
  git clone --depth 1 --branch "$TAG" https://chromium.googlesource.com/chromium/src.git src
fi
cd src
if [ "$(git describe --tags --exact-match 2>/dev/null || true)" != "$TAG" ]; then
  git fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
  git checkout -f "$TAG"
fi
if [ ! -f "$WORK/.synced-$TAG" ]; then
  gclient sync -D --no-history --nohooks
  gclient runhooks
  touch "$WORK/.synced-$TAG"
fi

step "VGC patches"
PATCHES="vgc-native-all vgc-uach-chrome-brand vgc-webgpu-identity"
# If a patch file changed since it was applied (git pull between runs), neither its
# reverse check nor a forward apply can succeed on the tree. Reset the tracked files of
# src to the tag once and apply the current patches cleanly (DEPS checkouts are separate
# repositories and are untouched).
needs_reset=0
for p in $PATCHES; do
  tr -d '\r' < "$REPO/engine-src/patches/$p.patch" > "/tmp/$p.patch"
  if ! git apply --check --reverse "/tmp/$p.patch" >/dev/null 2>&1 &&
     ! git apply --check "/tmp/$p.patch" >/dev/null 2>&1; then
    needs_reset=1
  fi
done
if [ "$needs_reset" = 1 ]; then
  echo "A patch no longer matches the tree (changed since the last run) — resetting src to $TAG and re-applying."
  git checkout -f -- .
fi
for p in $PATCHES; do
  if git apply --check --reverse "/tmp/$p.patch" >/dev/null 2>&1; then
    echo "$p: already applied"
  else
    git apply --whitespace=nowarn "/tmp/$p.patch"
    echo "$p: applied"
  fi
done
grep -q VgcWebGpuIdentity third_party/blink/renderer/modules/webgpu/gpu_adapter.cc || {
  echo "vgc-webgpu-identity.patch is not in the tree; refusing to build engine $VER" >&2; exit 1; }

step "GN args → out/vgc"
mkdir -p out/vgc
{
  sed -e "s/^target_cpu = .*/target_cpu = \"$CPU\"/" "$REPO/engine-src/args.gn"
  echo 'target_os = "mac"'
  echo 'use_remoteexec = false'
} > out/vgc/args.gn
gn gen out/vgc

step "Building chrome (this is the long part)"
if [ -n "$JOBS" ]; then autoninja -C out/vgc -j "$JOBS" chrome; else autoninja -C out/vgc chrome; fi
APP="$WORK/src/out/vgc/Chromium.app"
[ -d "$APP" ] || { echo "Build finished but $APP is missing." >&2; exit 1; }

step "Packaging engine $VER"
cd "$REPO"
VGC_CHROMIUM_SRC="$WORK/src" VGC_ENGINE_ARCH="$CPU" bash scripts/package-mac-engine.sh "$APP" "$VER"
echo
echo "Done: release/vgc-core-mac-$CPU-$VER.zip (+ .sha256). Upload it with"
echo "  bash scripts/publish-dl.sh release/vgc-core-mac-$CPU-$VER.zip"
echo "(verified on the server), then pin the URL + SHA-256 in src/main/settings.ts (ENGINE_MANIFEST) and release the app."
