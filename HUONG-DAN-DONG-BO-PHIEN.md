# Đồng bộ phiên giữa nhiều máy (Windows ⇄ MacBook) — cách hoạt động & cách kiểm tra

> Mục tiêu (kiểu GoLogin): mở profile ở máy nào cũng có đúng phiên đăng nhập mới nhất; hai máy mở
> cùng lúc thì chỉ **một** máy được chạy, máy kia tự lưu phiên rồi đóng; không bao giờ mất phiên.

## 1. Cơ chế

| Thành phần | Ở đâu | Làm gì |
|---|---|---|
| Khoá độc quyền | `src/main/profile-lock.ts` + `supabase/profile-locks.sql` | Mỗi lần mở là một "epoch" tăng dần. Máy đang giữ profile poll 2,5 s/lần; thấy epoch cao hơn → **bị đá**: lưu phiên rồi đóng (trước đây 6 s/lần). |
| Bàn giao phiên | cột `session_tag` của bảng `profile_locks` | Máy bị đá ghi `saving:<n>` (n tăng 4 s/lần) trong lúc lưu → máy mới **chờ tiếp** chừng nào bộ đếm còn nhảy (tối đa 3 phút). Lưu xong ghi ETag thật; lưu hỏng ghi `failed:<lý do>`. |
| Gói phiên (zip) | `src/main/cloud-data.ts` | Local Storage / IndexedDB / Preferences / tab → Supabase Storage, mã hoá bằng khoá tài khoản. **Không** chứa Cookies / Login Data / Local State (khoá os_crypt riêng từng máy). |
| Cầu nối cookie + mật khẩu | `src/main/password-bridge.ts` | Khi đóng: giải mã bằng khoá máy này → **hợp nhất** với bản cloud (cookie bạn đã xoá/đăng xuất trong phiên này thì không bị "sống lại"; nếu profile vừa chạy ở máy khác thì tải lại bản cloud mới nhất trước khi gộp) → upload. Khi mở: tải về → gộp vào DB cục bộ, mã hoá lại bằng khoá máy này. Không bao giờ ghi đè cả bộ bằng bản thiếu. |
| Mở lần đầu trên máy mới | `bootstrapProfileStores` (profile-manager.ts) | Chạy engine ẩn ~0,6 s để tạo Cookies DB, Login Data, khoá os_crypt → cầu nối có chỗ để gộp. Không có bước này, lần mở đầu tiên trên máy mới sẽ chưa đăng nhập. |
| Đóng engine êm | `stopProfile` / `requestEngineExit` | Windows: `taskkill /PID` (WM_CLOSE); macOS: SIGTERM; automation: CDP `Browser.close`. Dừng cưỡng bức làm mất cookie ghi trong ~30 s cuối (đã đo thực tế). |
| Chống ghi đè | `cloudSessionState` + `allowCloudTag` | Không ghi đè bản cloud mới hơn bản mình đã đồng bộ — **trừ** khi bản mới đó chính là bàn giao muộn dành cho epoch của mình (máy đang chạy là máy thắng). |
| Thoát app / đổi tài khoản | `stopRunningAndSync` | Chờ upload đang dở, đóng êm, upload, **rồi mới** nhả khoá. Trần chờ 90 s. |
| Engine mồ côi | `reapOrphanEngines` | App crash để lại engine chạy không có poll → lúc khởi động app đóng êm engine cũ (kiểm tra command line, không tin PID suông). |

## 2. Điều kiện bắt buộc ở **mỗi** máy

1. Đăng nhập cloud cùng tài khoản.
2. **Nhập passphrase mã hoá cloud** (Cài đặt → Mã hoá cloud). Thiếu bước này, máy đó không giải mã được phiên và app sẽ báo rõ.
3. `supabase/profile-locks.sql` đã chạy trên project Supabase (chỉ cần một lần).
4. Đồng hồ hai máy lệch dưới 2 phút (NTP bật). Lệch nhiều hơn, cookie "mới hơn" có thể bị so sai.

## 3. Những thông báo cần để ý (toast dính 15 s, bấm để ẩn)

- **"…vừa được mở ở máy khác — đang lưu phiên ở đây rồi đóng"**: máy này bị đá, bình thường.
- **"Máy X không phản hồi (đang ngủ / mất mạng?) — mở bằng bản cloud gần nhất"**: máy kia chưa lưu được phiên mới nhất lên cloud. Khi máy kia tỉnh lại nó sẽ tự lưu; cookie/mật khẩu được gộp, còn tab/localStorage máy đang chạy sẽ thắng.
- **"CHƯA lưu được phiên (tab/localStorage) lên cloud: …"**: phiên vẫn còn nguyên trên máy này, mở lại profile ở máy này để tự sửa.
- **"Không kết nối được khoá đồng bộ (…) — mở KHÔNG có bảo vệ chống mở trùng máy"**: mất mạng hoặc chưa chạy SQL; đừng mở ở máy khác cùng lúc.

## 4. Kiểm tra bằng máy

```bash
npm run verify:bootstrap   # thư mục trống → khởi tạo → gộp cookie/mật khẩu → engine đọc lại được
npm run verify:stop        # cookie vừa set 2 s trước có còn trên đĩa sau khi dừng êm không
npm run verify:stop -- --forced   # đối chứng: dừng cưỡng bức làm mất cookie (Windows)
```

Trên Windows không cài VGC Core, script tự dùng Google Chrome (cùng mã os_crypt). Trên macOS, chạy để
xác nhận phần Keychain (`security find-generic-password … "Chromium Safe Storage"`, cho phép "Always Allow").

## 5. Nhật ký chẩn đoán

`vgc-sess.log` trong thư mục userData của app (Windows: `%APPDATA%\vgc-browser`, macOS:
`~/Library/Application Support/vgc-browser`). Mọi bước khoá (`[lock …]`), đồng bộ (`[sync …]`), cookie
(`[creds …]`, `[vgc-pw …]`), đóng (`[close …]`), thoát (`[quit …]`) đều có dòng riêng kèm lý do khi bỏ qua.

## 6. Giới hạn đã biết

- Cookie **phiên** (không có hạn) không bao giờ tồn tại qua một lần khởi động lại Chromium (đo trên
  Chrome 152, kể cả `--restore-last-session`), nên không thể đồng bộ; đa số web dùng cookie có hạn.
- Khi máy A ngủ với profile đang mở, những gì làm trên A sau lần lưu cuối chỉ lên cloud khi A tỉnh lại.
  Phần tab/localStorage của A khi đó sẽ **thua** máy đang chạy; cookie/mật khẩu thì được gộp.
- Nút "Đẩy lên (kèm phiên)" bị từ chối chừng nào máy khác còn giữ profile (kể cả máy đang ngủ) — mở rồi đóng
  profile ở bất kỳ máy nào sẽ giải phóng.
- Chạy tự động (nuôi acc theo lịch, đổi mật khẩu hàng loạt) **không** đá máy đang dùng: gặp profile đang mở ở
  máy khác (hoặc không đọc được khoá) thì bỏ qua và thử lại lần sau.
