# VGC Browser — chế độ NỘI BỘ (chỉ công ty dùng)

Từ bản **2.2.0**, VGC Browser chỉ chạy với **máy chủ riêng của công ty** (Xeon, qua
`sync.vgcbrowser.com`). Cloud Supabase cũ đã huỷ hẳn ngày 6/11/2026. Máy chủ tắt = không mở được app.
Chỉ những email nằm trong **danh sách nhân viên trên máy chủ** mới vào được, kể cả khi đúng mật khẩu.

## Người dùng thấy gì

| Tình huống | App hiển thị |
|---|---|
| Email chưa được duyệt | Màn hình "Tài khoản chưa được cấp quyền" + nút **Kiểm tra lại** / **Đăng xuất** |
| Email đã duyệt nhưng hết hạn | "Quyền truy cập đã hết hạn" (kèm ngày hết hạn) |
| Không tới được máy chủ (4 lần ping liên tiếp, ~2 phút) | Các profile đang mở được đóng, app về màn hình "Máy chủ công ty không liên lạc được" |
| Chủ bật lệnh huỷ khẩn cấp | App xoá toàn bộ dữ liệu VGC trên máy đó rồi đứng ở màn hình bị khoá |
| Đang dùng mà bị bỏ duyệt | Trong tối đa 10 phút: các profile đang mở được đóng và lưu lên máy chủ, app về màn hình bị chặn |

## Quản trị viên thêm nhân viên (3 bước)

1. Trên Mac của chủ chạy `server/admin.sh` (mở trang quản trị qua đường hầm SSH, chỉ máy có khoá mới vào được)
   → ô **email nhân viên** → **Thêm / cập nhật** (có thể đặt ngày hết hạn).
2. Nhân viên mở VGC Browser → tab **Tạo tài khoản** → nhập đúng email đó + mật khẩu.
   App kiểm tra danh sách trước khi tạo; email chưa duyệt sẽ bị từ chối ngay.
3. Đăng nhập. Xong.

Thu hồi: bấm **Chặn** ở dòng người đó trên trang quản trị. Không cần làm gì thêm trên máy họ.

## Bảo vệ nhiều lớp

- **Lúc đăng nhập** (`src/renderer/Gate.tsx`): main process lấy email từ token đã xác thực rồi hỏi
  máy chủ (`/vgc/v1/license/check`); renderer không thể tự khai email khác.
- **Lúc đang dùng**: kiểm tra lại mỗi 10 phút và mỗi lần cửa sổ được focus; ping máy chủ mỗi 30 giây.
- **Lúc mở profile** (`src/main/profile-manager.ts`): phải ping được máy chủ và còn quyền.
- **Lúc tạo tài khoản** (`license:precheck`): email phải có sẵn trong danh sách.
- **Mọi lời gọi** tới máy chủ phải mang khoá app (`X-VGC-Key`, đặt lúc build bằng secret CI); thiếu khoá
  thì cổng trả 404 như không tồn tại.
- **Bản cũ**: nâng `minVersion` trong `public_html/dl/min-version.json` để buộc cập nhật.

## Huỷ / khôi phục máy chủ (chỉ chủ)

- `server/kill.sh [--erase]`: khoá ổ dữ liệu (và xoá đầu LUKS nếu `--erase`) — mất ổ là mất tất cả.
- `server/restore.sh`: khôi phục từ bản sao đầu LUKS + mật khẩu (chỉ có trên Mac của chủ).
- Sao lưu đầy đủ gần nhất: `/srv/vgc/backup/` trên Xeon (trong ổ mã hoá).
