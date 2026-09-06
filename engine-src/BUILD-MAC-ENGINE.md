# Build engine VGC Core cho macOS trên MacBook

**Trạng thái: engine 0.1.101 đã build, verify (18/18 `verify:engine` + WebGPU identity
khớp WebGL qua `probe:gpu`), upload lên `vgcbrowser.com/dl`, và ghim vào
`src/main/settings.ts` (2026-09-06).** Bản này có đủ ba bản vá (`engine-src/patches/`),
gồm `vgc-webgpu-identity.patch` nên app không còn phải tắt WebGPU trên Mac (gate
`>= 0.1.101` trong `src/main/engine-caps.ts`).

Phần dưới đây vẫn giữ nguyên cho lần build engine TIẾP THEO (bump Chromium tag, thêm
patch mới, …) — script tự đọc phiên bản engine mục tiêu, không cần sửa gì trong file này.

Việc này chỉ làm được trên máy Mac (Chromium cho macOS phải build bằng Xcode). Máy chạy
GitHub Actions không đủ đĩa, VPS Windows không build chéo được.

## Cần có

- MacBook Apple Silicon (M1 trở lên). Intel cũng build được nhưng lâu hơn nhiều.
- macOS 14.5 trở lên và **Xcode 16 trở lên** (Chromium 151 cần SDK macOS 15). Cài Xcode
  đầy đủ từ App Store (không chỉ Command Line Tools), mở một lần để chấp nhận license, rồi:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app
  sudo xcodebuild -license accept
  ```
- Node.js (đã có nếu từng build app), git.
- Khoảng **120 GB đĩa trống**, mạng ổn định (tải ~25 GB source).
- Thời gian: tải 20–40 phút, biên dịch 3–8 giờ tùy máy. Cắm sạc, tắt chế độ ngủ.

## Chạy

Trong thư mục repo VGCBrowser (đã `git pull` bản mới nhất):

```bash
chmod +x engine-src/build-mac-engine.sh
caffeinate -i engine-src/build-mac-engine.sh
```

Script tự làm hết: tải depot_tools, lấy đúng tag Chromium trong
`src/shared/engine-release.json`, `gclient sync`, áp ba bản vá, `gn gen`, `autoninja`,
rồi gọi `scripts/package-mac-engine.sh` để đóng gói. Chạy lại lệnh trên nếu bị ngắt,
script tiếp tục từ bước đã xong.

Không có Apple Developer ID thì engine được ký ad-hoc (giống app hiện tại). Khi có
Developer ID, đặt `MAC_DEVELOPER_ID` và `VGC_NOTARY_PROFILE` trước khi chạy để ký và
notarize.

## Sau khi build xong

Kết quả nằm ở `release/vgc-core-mac-arm64-0.1.101.zip` và file `.sha256` bên cạnh.

1. Đưa zip lên server bằng script upload có kiểm hash (tải lên tên tạm, so sha256 trên
   server, rồi mới đổi tên; một lần upload đứt giữa chừng đã từng để lại file zip cụt):
   ```bash
   bash scripts/publish-dl.sh release/vgc-core-mac-arm64-0.1.101.zip
   ```
   Cần key SSH của Hostinger ở `~/.ssh/id_ed25519` (hoặc đặt `VGC_SSH_KEY`).
2. Gửi lại nội dung file `.sha256`. Phần còn lại (ghim URL + hash trong
   `src/main/settings.ts`, phát hành app) làm trên VPS.

## Kiểm tra trước khi upload (tùy chọn)

```bash
VGC_ENGINE_PATH="$HOME/vgc-chromium/src/out/vgc/Chromium.app/Contents/MacOS/Chromium" npm run verify:engine
```
