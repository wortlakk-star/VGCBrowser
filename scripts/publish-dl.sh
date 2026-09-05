#!/usr/bin/env bash
# Publish release files to vgcbrowser.com/dl over SSH so that no client can ever see an
# update manifest that points at an incomplete binary:
#   1. every binary is uploaded under a temporary name, its SHA-256 is checked on the
#      server, and only then is it renamed into place (retried up to 6 times);
#   2. the update manifest (latest.yml / latest-mac.yml) is uploaded last, the same way.
# A cut connection (which truncated the 2.1.77 macOS zip to 109 MB while scp still left it
# under its final name) therefore fails the job instead of shipping a broken update.
#
# Usage: scripts/publish-dl.sh <manifest.yml> <binary>...
# Env:   VGC_SSH_KEY   private key file (default ~/.ssh/id_ed25519)
#        VGC_DL_DEST   remote directory (default domains/vgcbrowser.com/public_html/dl)
#        VGC_SITE_INDEX optional local landing page, uploaded last to <DEST>/../index.html
set -euo pipefail

HOST='u469659181@212.85.28.201'
PORT=65002
KEY="${VGC_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DEST="${VGC_DL_DEST:-domains/vgcbrowser.com/public_html/dl}"
ATTEMPTS=6
OPTS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o ConnectTimeout=30)

if [ $# -lt 1 ]; then
  echo "usage: $0 <manifest.yml> <binary>..." >&2
  exit 2
fi
[ -r "$KEY" ] || { echo "::error::SSH key $KEY is missing" >&2; exit 2; }
for f in "$@" ${VGC_SITE_INDEX:+"$VGC_SITE_INDEX"}; do
  [ -f "$f" ] || { echo "::error::$f is not a file" >&2; exit 2; }
done

local_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

remote() { ssh -p "$PORT" "${OPTS[@]}" "$HOST" "$@"; }

# upload_verified <local file> <remote dir> <remote name>
upload_verified() {
  local file=$1 dir=$2 name=$3 want tmp attempt
  want=$(local_sha256 "$file")
  tmp=".$name.part-$$"
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if scp -P "$PORT" "${OPTS[@]}" "$file" "$HOST:$dir/$tmp" \
      && remote "cd '$dir' && got=\$(sha256sum '$tmp' | cut -d' ' -f1) && [ \"\$got\" = '$want' ] && mv -f '$tmp' '$name'"; then
      echo "published $dir/$name  sha256=$want  $(wc -c < "$file" | tr -d ' ') bytes"
      return 0
    fi
    echo "upload of $name failed or arrived corrupt (attempt $attempt/$ATTEMPTS); retrying in $((attempt * 20))s" >&2
    remote "rm -f '$dir/$tmp'" || true
    sleep $((attempt * 20))
  done
  echo "::error::$name could not be uploaded intact after $ATTEMPTS attempts" >&2
  return 1
}

manifest=$1
shift
remote "mkdir -p '$DEST' && find '$DEST' -maxdepth 1 -name '.*.part-*' -mmin +120 -delete 2>/dev/null; true"
for f in "$@"; do
  upload_verified "$f" "$DEST" "$(basename "$f")"
done
upload_verified "$manifest" "$DEST" "$(basename "$manifest")"
if [ -n "${VGC_SITE_INDEX:-}" ]; then
  upload_verified "$VGC_SITE_INDEX" "$(dirname "$DEST")" "index.html"
fi
echo "Published $(basename "$manifest") and $# file(s) to https://vgcbrowser.com/dl/"
