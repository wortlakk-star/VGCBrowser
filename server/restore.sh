#!/bin/bash
# KHÔI PHỤC VGC sau huỷ khẩn cấp hoặc sau khi máy chủ khởi động lại (phân vùng tự khoá).
#   Hỏi mật khẩu phân vùng (không lưu ở đâu). Nếu khoá phân vùng đã bị xoá (kill.sh --erase), dùng bản
#   sao đầu phân vùng ~/private-keys/servers/xeon/vgc-luks-header.img để dựng lại trước.
set -euo pipefail
SSH="ssh -n -i $HOME/.ssh/macsync_ed25519 -o BatchMode=yes -o ConnectTimeout=8 vgc@192.168.1.19"
SSHIN="ssh -i $HOME/.ssh/macsync_ed25519 -o BatchMode=yes -o ConnectTimeout=8 vgc@192.168.1.19"
# Đọc mật khẩu TRƯỚC mọi lệnh ssh (ssh đọc stdin sẽ nuốt mất mật khẩu truyền qua ống).
if [ -t 0 ]; then read -r -s -p "Mật khẩu phân vùng VGC: " PASS; echo; else PASS=$(cat); fi
[ -n "$PASS" ] || { echo "Chưa nhập mật khẩu."; exit 1; }
HDR="$HOME/private-keys/servers/xeon/vgc-luks-header.img"
if ! $SSH 'sudo cryptsetup isLuks /dev/disk/by-partlabel/VGC-DATA && sudo cryptsetup luksDump /dev/disk/by-partlabel/VGC-DATA | grep -q "^  0: luks2"'; then
  echo "Khoá phân vùng đã bị xoá — dựng lại từ bản sao đầu phân vùng."
  [ -f "$HDR" ] || { echo "KHÔNG có $HDR — không khôi phục được."; exit 1; }
  $SSHIN 'umask 077; cat > /tmp/vgc-hdr.img && sudo cryptsetup luksHeaderRestore --batch-mode /dev/disk/by-partlabel/VGC-DATA --header-backup-file /tmp/vgc-hdr.img; shred -u /tmp/vgc-hdr.img' < "$HDR"
fi
printf '%s' "$PASS" | $SSHIN 'sudo /usr/local/sbin/vgc-unlock'; unset PASS
echo "Chờ máy chủ chạy lên…"; for i in $(seq 1 30); do sleep 5; $SSH 'curl -s -m 3 http://127.0.0.1:8300/vgc/v1/health' >/dev/null 2>&1 && break; done
$SSH 'curl -s -o /dev/null -w "go lenh huy: %{http_code}\n" --data "x=1" http://127.0.0.1:8301/unkill'
echo "Đã khôi phục. Nhân viên đăng nhập lại VGC là dùng được."
