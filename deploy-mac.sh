#!/usr/bin/env bash
# VGC Browser - deploy the macOS build to vgcbrowser.com/dl
# Usage:  ./deploy-mac.sh
#
# Uploads latest-mac.yml + the mac .zip/.dmg from release/ to the website so the
# in-app "Kiem tra cap nhat" works on macOS. Without these, the updater requests
# https://vgcbrowser.com/dl/latest-mac.yml and gets a 404 (the Windows deploy.ps1
# only publishes the .exe/.7z/latest.yml). This is the macOS counterpart.
#
# Auth: uses your SSH key if present; otherwise scp prompts for the password.
# Run AFTER `npm run dist:mac`.
set -euo pipefail

SSH_HOST=212.85.28.201
SSH_PORT=65002
SSH_USER=u469659181
REMOTE='domains/vgcbrowser.com/public_html/dl'   # vgcbrowser.com addon-domain webroot/dl

cd "$(dirname "$0")"
REL=release

YML="$REL/latest-mac.yml"
if [ ! -f "$YML" ]; then
  echo "No $YML found. Run 'npm run dist:mac' first." >&2
  exit 1
fi

# latest-mac.yml + every mac artifact it can reference (zip is required by Squirrel.Mac).
FILES=("$YML")
for f in "$REL"/VGC-Browser-*-mac-*.zip "$REL"/VGC-Browser-*-mac-*.zip.blockmap "$REL"/VGC-Browser-*-mac-*.dmg; do
  [ -f "$f" ] && FILES+=("$f")
done

echo "Uploading to ${SSH_USER}@${SSH_HOST}:${REMOTE}/"
printf '  %s\n' "${FILES[@]}"

ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE"
scp -P "$SSH_PORT" "${FILES[@]}" "${SSH_USER}@${SSH_HOST}:${REMOTE}/"

echo ""
echo "Done. Verify: curl -I https://vgcbrowser.com/dl/latest-mac.yml  (expect HTTP 200)"
