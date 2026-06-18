# Hướng dẫn: sửa lỗi "xóa profile rồi F5 vẫn còn"

Làm theo đúng thứ tự 3 bước. Chỉ mất ~5 phút, làm 1 lần duy nhất.

---

## BƯỚC 1 — Chạy SQL trên Supabase (1 lần duy nhất)

1. Mở link này (bấm vào): **https://supabase.com/dashboard/project/pwiledrttvbnmytghyip/sql/new**
   - Nếu hỏi đăng nhập → đăng nhập tài khoản Supabase của bạn.
   - Link này mở thẳng ô **SQL Editor → New query** của project VGC.
2. Dán đúng 2 dòng dưới đây vào ô trống:

   ```sql
   alter table public.profiles_cloud add column if not exists deleted boolean not null default false;
   alter table public.proxies_cloud  add column if not exists deleted boolean not null default false;
   ```

3. Bấm nút **Run** (góc dưới bên phải, hoặc Ctrl + Enter).
4. Thấy chữ **Success** (màu xanh) là xong.

---

## BƯỚC 2 — Phát hành bản mới (trên máy này)

Mở **PowerShell** ngay trong thư mục `C:\VGCBrowser` rồi gõ:

```powershell
powershell -ExecutionPolicy Bypass -File .\release.ps1
```

Chờ chạy xong (build + đẩy lên web vgcbrowser.com).

---

## BƯỚC 3 — Update app trên CẢ 2 MÁY

1. Mở app VGC Browser trên **máy 1** → bấm **Update** → chờ cài xong → mở lại.
2. Làm y hệt trên **máy 2**.

---

## XONG — giờ xóa profile như sau

- Tick chọn các profile rác → bấm **Xoá**.
- Lần này nó xóa **cả trên cloud** → mất luôn ở cả 2 máy.
- Bấm **↻ Làm mới** (F5) → KHÔNG còn quay lại nữa. ✅

---

### Lưu ý
- Phải làm **Bước 1 trước Bước 2**.
- 13 profile đang kẹt: sau khi update app (Bước 3), chỉ cần chọn + Xoá 1 lần là sạch ở cả 2 máy.
