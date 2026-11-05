#!/bin/bash
# Mở trang quản trị máy chủ VGC (chỉ chủ — cần khoá SSH của Mac này). Đóng cửa sổ Terminal = đóng đường hầm.
set -e
ssh -i "$HOME/.ssh/macsync_ed25519" -o ExitOnForwardFailure=yes -N -L 8301:127.0.0.1:8301 vgc@192.168.1.19 &
PID=$!; trap 'kill $PID 2>/dev/null' EXIT
sleep 1.5; open "http://127.0.0.1:8301/"
echo "Trang quản trị: http://127.0.0.1:8301/  (Ctrl+C để đóng)"; wait $PID
