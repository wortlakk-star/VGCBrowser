#!/bin/bash
# HUỶ KHẨN CẤP VGC — chỉ chủ chạy trên Mac có khoá SSH.
#   server/kill.sh          → phát lệnh huỷ (app nhân viên tự xoá dữ liệu trên máy) rồi KHOÁ máy chủ.
#                             Khôi phục: server/restore.sh (cần mật khẩu phân vùng).
#   server/kill.sh --erase  → như trên + XOÁ KHOÁ phân vùng trên máy chủ: dữ liệu không ai mở được nữa,
#                             TRỪ KHI có bản sao đầu phân vùng (~/private-keys/servers/xeon/vgc-luks-header.img)
#                             + mật khẩu. Không có 2 thứ đó = mất vĩnh viễn.
set -euo pipefail
SSH="ssh -n -i $HOME/.ssh/macsync_ed25519 -o BatchMode=yes -o ConnectTimeout=8 vgc@192.168.1.19"
ERASE=0; [ "${1:-}" = "--erase" ] && ERASE=1
echo "Sẽ HUỶ KHẨN CẤP VGC$([ $ERASE = 1 ] && echo ' và XOÁ KHOÁ phân vùng máy chủ')."
read -r -p "Gõ HUY để tiếp tục: " c; [ "$c" = "HUY" ] || { echo "Đã bỏ."; exit 1; }
$SSH 'curl -s -o /dev/null -w "lenh huy: %{http_code}\n" --data "confirm=HUY" http://127.0.0.1:8301/kill' || echo "(không phát được lệnh huỷ — vẫn khoá máy chủ)"
echo "Chờ 150 giây để mọi app nhân viên nhận lệnh và xoá dữ liệu trên máy…"
for i in $(seq 150 -10 10); do printf "\r  còn %3ss" $i; sleep 10; done; echo
$SSH 'sudo /usr/local/sbin/vgc-lock'
if [ $ERASE = 1 ]; then
  $SSH 'sudo cryptsetup luksErase --batch-mode /dev/disk/by-partlabel/VGC-DATA && echo "DA XOA KHOA PHAN VUNG"'
fi
echo "Xong. Máy chủ VGC đã khoá — không ai dùng được VGC cho tới khi chạy server/restore.sh."
