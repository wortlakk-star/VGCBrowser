# Bộ test tính năng (khoá/tự huỷ, extension khoá, passkey, két)

Tất cả chạy trên **bản cách ly** hoặc bản mô phỏng — KHÔNG đụng dữ liệu thật.

| File | Kiểm tra gì | Cách chạy |
|---|---|---|
| `guard-e2e.cjs` | Khoá profile/nhóm, sai N lần tự huỷ, mật khẩu chủ, SOS, bật/tắt passkey theo profile | Dựng bản cách ly (bên dưới) rồi `node guard-e2e.cjs` |
| `lock-ext-e2e.cjs` | Extension khoá cửa sổ: khoá → thu nhỏ + hộp mật khẩu, sai/đúng | `node lock-ext-e2e.cjs` (cần engine VGC) |
| `passkey-e2e.mjs` | Extension passkey với máy chủ WebAuthn thật (SimpleWebAuthn) trong engine VGC | `npm i` trong thư mục này rồi `node build.mjs && node passkey-e2e.mjs` |
| `vault-unit.cjs` | Sao lưu tự động/file `.vgcpk`, két passkey theo tài khoản (2 máy giả lập, RLS thật) | `node vault-unit.cjs` (dùng esbuild của repo) |
| `version-gate-live.cjs` | Cổng chặn bản cũ: chạy mã thật với `min-version.json` thật trên vgcbrowser.com (bản cũ bị chặn, bản mới/mất mạng thì mở) | `node version-gate-live.cjs` |

## Dựng bản VGC cách ly (cho `guard-e2e.cjs`)

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
$ud = "$env:TEMP\vgc-guard-test-ud"
$p = Start-Process "$env:LOCALAPPDATA\Programs\vgc-browser\VGC Browser.exe" `
  -ArgumentList "--user-data-dir=`"$ud`"","--remote-debugging-port=9333" -PassThru
# ... chạy test ...
taskkill /PID $p.Id /T /F        # CHỈ tắt theo PID, không tắt theo tên (đang có app thật chạy)
```

Test dừng ngay nếu danh sách profile không rỗng (dấu hiệu không phải bản cách ly).
