#!/bin/bash
# Đưa dịch vụ chuyển dữ liệu lên Xeon và khởi động lại. Dùng: server/deploy-migrate.sh
# Cấu hình nguồn (cloud) nằm ở /srv/vgc/migrate/env trên Xeon (không có trong repo).
set -euo pipefail
cd "$(dirname "$0")"
SSH="ssh -i $HOME/.ssh/macsync_ed25519 -o BatchMode=yes vgc@192.168.1.19"
node --check migrate/server.mjs
$SSH 'sudo install -d -m 700 /srv/vgc/migrate && sudo tee /srv/vgc/migrate/server.mjs >/dev/null' < migrate/server.mjs
$SSH 'sudo docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres' < sql/xeon-server.sql
$SSH 'sudo bash -s' <<'R'
set -e
docker rm -f vgc-migrate >/dev/null 2>&1 || true
docker run -d --name vgc-migrate --restart unless-stopped --network host --read-only --user 1000:1000 \
  --env-file /srv/vgc/migrate/env -v /srv/vgc/migrate/server.mjs:/app/server.mjs:ro node:22-alpine node /app/server.mjs >/dev/null
sleep 2; docker logs vgc-migrate 2>&1 | tail -3
R
