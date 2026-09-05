# VGC Browser — chế độ NỘI BỘ (chỉ công ty dùng)

Từ bản **2.1.74**, VGC Browser chỉ cho phép những email nằm trong **danh sách nội bộ**
do quản trị viên quản lý tại `https://vgcbrowser.com/quanly` (mục "Người dùng VGC").
Tài khoản không có trong danh sách **không vào được app**, kể cả khi đã đăng nhập đúng
mật khẩu.

## Người dùng thấy gì

| Tình huống | App hiển thị |
|---|---|
| Email chưa được duyệt | Màn hình "Tài khoản chưa được cấp quyền" + nút **Kiểm tra lại** / **Đăng xuất** |
| Email đã duyệt nhưng hết hạn | "Quyền truy cập đã hết hạn" (kèm ngày hết hạn) |
| Đăng nhập được Supabase nhưng không tới được vgcbrowser.com | Nếu 24 giờ gần nhất đã được duyệt thì vẫn vào bình thường; quá 24 giờ thì hiện "Chưa xác minh được quyền truy cập" |
| Mất mạng hoàn toàn | Về màn hình đăng nhập như trước (không xác thực được phiên Supabase) |
| Đang dùng mà bị bỏ duyệt | Trong tối đa 10 phút (hoặc ngay khi bấm sang cửa sổ app): các profile đang mở được đóng và lưu phiên lên cloud, app chuyển về màn hình bị chặn kèm dòng "Đang đóng N profile…" |
| Đang dùng mà chặn vgcbrowser.com để né kiểm tra | Hết 24 giờ kể từ lần duyệt cuối, hai lần kiểm tra liên tiếp không hỏi được máy chủ là bị đá ra |

## Quản trị viên thêm nhân viên (3 bước)

1. Vào `https://vgcbrowser.com/quanly`, ô **"Duyệt thêm email"** → nhập email nhân viên →
   **Duyệt** (có thể đặt ngày hết hạn).
2. Nhân viên mở VGC Browser → tab **Tạo tài khoản** → nhập đúng email đó + mật khẩu.
   App kiểm tra danh sách trước khi tạo; email chưa duyệt sẽ bị từ chối ngay.
3. Đăng nhập. Xong.

Thu hồi: bấm **Bỏ duyệt** ở dòng người đó. Không cần làm gì thêm trên máy họ.

## Bảo vệ nhiều lớp

- **Lúc đăng nhập** (`src/renderer/Gate.tsx`): main process tự lấy email từ token đã xác
  thực rồi hỏi `check.php`; renderer không thể tự khai email khác.
- **Lúc đang dùng**: kiểm tra lại mỗi 10 phút và mỗi lần cửa sổ được focus (tối đa 1 lần/phút).
  Chỉ khi máy chủ **khẳng định** "không duyệt / hết hạn" mới đá ra; mất mạng không đá.
- **Lúc mở profile** (`src/main/profile-manager.ts`): kiểm tra lại lần nữa.
- **Lúc tạo tài khoản** (`license:precheck`): email phải có sẵn trong danh sách.
- **Bản cũ** (≤ 2.1.73 chưa có chốt đăng nhập): nâng `minVersion` trong
  `public_html/dl/min-version.json` lên `2.1.74` để buộc cập nhật.

## PHẢI làm thêm trong Supabase (chống chiếm email)

Danh sách nội bộ chỉ so **địa chỉ email**. Supabase hiện đang **tự xác nhận email** (không cần
bấm link), nên giữa lúc quản trị viên duyệt email và lúc nhân viên tạo tài khoản, một người
ngoài biết địa chỉ đó có thể "tạo tài khoản" trước bằng mật khẩu của họ và dùng được app.
Chọn MỘT trong hai cách:

1. **Bật xác nhận email** (khuyên dùng, giữ được tab "Tạo tài khoản"): Supabase → Authentication
   → Providers → Email → bật **Confirm email**. Người tạo tài khoản phải bấm link gửi về đúng
   hộp thư đó, người ngoài không có hộp thư nên không tạo được.
2. **Tắt đăng ký công khai**: Authentication → Providers → Email → tắt **Allow new users to sign
   up**. Khi đó quản trị viên tạo tài khoản cho nhân viên tại Authentication → Users → Add user
   (app sẽ báo "Đăng ký đang tắt" ở tab Tạo tài khoản).

## Nên làm thêm

- Đổi mật khẩu trang `/quanly` (đang đặt cứng trong `quanly/index.php`, trùng với mật khẩu SSH).
- Rà lại danh sách đã duyệt: chỉ giữ email của công ty.
