# VGC Browser — Build bản macOS (.dmg) trên MacBook

> Làm trên **MacBook** (Intel hoặc Apple Silicon đều được). Dùng **VS Code** + Terminal.

## 1. Cài công cụ (1 lần)
Mở **Terminal** (Cmd+Space → gõ "Terminal"):

```bash
# Xcode Command Line Tools (cần để build)
xcode-select --install
```
- Cài **Node.js** bản LTS: https://nodejs.org → tải .pkg → cài. Kiểm tra: `node -v` (≥ 18).
- Cài **Google Chrome** trên Mac: https://www.google.com/chrome  (VGC Browser bản Mac dùng Chrome này làm engine).

## 2. Lấy source code sang MacBook (chọn 1 cách)
File `vgc-browser-source.zip` đang ở **Desktop của máy Windows (VPS)**. Chuyển sang Mac:
- **Cách A — Google Drive (dễ nhất):** trên VPS mở trình duyệt → tải `vgc-browser-source.zip` lên Drive của bạn → trên Mac mở Drive → tải về → giải nén.
- **Cách B — GitHub (tốt nhất cho VS Code):** mình tạo sẵn git repo; bạn tạo repo **Private** trên github.com rồi push; trên Mac `git clone`.
- **Cách C — USB / WeTransfer.**

Giải nén xong → mở thư mục bằng **VS Code** (File → Open Folder).

## 3. Build (trong Terminal của VS Code: Terminal → New Terminal)
```bash
cd đường/dẫn/tới/VGCBrowser
npm install
npm run dist:mac
```
- `npm install` tải thư viện (~1–2 phút).
- ⚠️ Dùng **`npm run dist:mac`** (KHÔNG phải `npm run dist` — cái đó build cho Windows).
- `npm run dist:mac` build app → tạo file trong thư mục **`release/`**:
  - `VGC-Browser-0.1.30-mac-arm64.dmg` (máy Apple Silicon M1/M2/M3)
  - hoặc `...-mac-x64.dmg` (máy Intel)
  - kèm bản `.zip` tương ứng.

## 4. Chạy thử trên Mac
- Mở file `.dmg` → kéo **VGC Browser** vào Applications.
- Lần đầu mở: vì **chưa ký số (Apple)**, macOS sẽ chặn → **chuột phải vào app → Open → Open** (chỉ cần 1 lần).
- App mở màn hình đăng nhập → đăng nhập → tạo/mở profile (profile chạy bằng **Google Chrome** đã cài + chống vân tay qua CDP).

## 5. Đưa bản .dmg lên web
Gửi mình file `.dmg` (hoặc tự upload vào `public_html/dl/` trên Hostinger). Mình sẽ thêm nút **"Tải cho macOS"** trên vgcbrowser.com.

---

## Ghi chú
- **Engine**: bản Mac hiện dùng **Google Chrome hệ thống** (chống vân tay qua CDP — Phase 1). Bản engine native “VGC Core” cho Mac (vân tay cấp C++) build sau, cần depot_tools + ~vài giờ compile trên Mac.
- **Ký số (hết cảnh báo Gatekeeper)**: cần **Apple Developer ($99/năm)**. Khi có, mình cấu hình ký + notarize tự động. Chưa có thì người dùng “chuột phải → Open”.
- **Universal (chạy cả Intel + Apple Silicon)**: đổi target trong `package.json` thành `"target": [{ "target": "dmg", "arch": ["universal"] }]` rồi build lại (lâu hơn). Mặc định build cho đúng máy bạn đang dùng.
- Lỗi `npm install` về quyền: thêm `sudo` hoặc dùng `nvm` để cài Node theo user.
