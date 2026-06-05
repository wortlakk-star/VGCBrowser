# VGC Browser — Code Signing (Azure Trusted Signing)

Mục tiêu: ký số file cài (`VGC-Browser-Web-Setup.exe` + `VGC Browser.exe` bên trong)
để Windows SmartScreen **không còn cảnh báo đỏ** khi khách tải/chạy.

Phương án: **Azure Trusted Signing** (~$9.99/tháng, không cần USB token).

---

## PHẦN A — Việc BẠN làm trên Azure Portal (1 lần, mất vài ngày chờ duyệt)

### 1. Tài khoản Azure
- Vào https://portal.azure.com → đăng nhập (tạo account nếu chưa có).
- Thêm phương thức thanh toán (thẻ Visa/Master). Có gói dùng thử $200 cho người mới.

### 2. Bật resource provider
- Portal → **Subscriptions** → chọn subscription → **Resource providers** →
  tìm `Microsoft.CodeSigning` → **Register**.

### 3. Tạo Trusted Signing Account
- Thanh tìm kiếm gõ **"Trusted Signing"** → **Create**.
- Region chọn 1 trong: **East US / West US 3 / West Central US / North Europe / West Europe**
  (ghi nhớ region — quyết định `endpoint` ở Phần B).
- Đặt tên account, ví dụ `vgc-signing`. SKU: **Basic** (~$9.99/tháng).

### 4. Xác minh danh tính (Identity Validation) — QUAN TRỌNG, mất 1–7 ngày
- Trong Trusted Signing account → **Identity validations** → **New**.
- Chọn:
  - **Organization** (doanh nghiệp): cần pháp nhân + giấy tờ DN. Microsoft yêu cầu
    DN đã đăng ký **> 3 năm** (nếu chưa đủ thì chọn Individual).
  - **Individual** (cá nhân): xác minh bằng CMND/CCCD/hộ chiếu qua đối tác xác minh.
- Điền đúng tên pháp lý → đây sẽ là **publisherName** hiển thị trên file.
- Nộp → chờ Microsoft duyệt (email báo kết quả).

### 5. Tạo Certificate Profile (sau khi danh tính được duyệt)
- Trusted Signing account → **Certificate profiles** → **Create**.
- Type: **Public Trust** (để phát hành ra ngoài).
- Chọn identity validation vừa duyệt → đặt tên profile, ví dụ `vgc-cert-profile`.

### 6. Cấp quyền ký (RBAC)
- Trusted Signing account → **Access control (IAM)** → **Add role assignment**.
- Role: **Trusted Signing Certificate Profile Signer**.
- Gán cho danh tính sẽ dùng để ký (xem Phần B chọn 1 trong 2 cách).

---

## PHẦN B — Cách xác thực khi ký (chọn 1)

### Cách 1 (đơn giản, ký trên máy này): Đăng nhập Azure CLI
- Cài Azure CLI: `winget install Microsoft.AzureCLI`
- `az login` (mở trình duyệt đăng nhập tài khoản Azure của bạn).
- Gán role ở bước A.6 cho chính user Azure đó.
- KHÔNG cần secret nào cả.

### Cách 2 (tự động/CI): Service Principal
- `az ad sp create-for-rbac --name vgc-signing-sp`
- Lấy 3 giá trị: **appId** (=AZURE_CLIENT_ID), **password** (=AZURE_CLIENT_SECRET),
  **tenant** (=AZURE_TENANT_ID).
- Gán role A.6 cho service principal này.
- Set 3 biến môi trường (KHÔNG dán secret vào chat — tự set trên máy):
  ```powershell
  setx AZURE_TENANT_ID     "<tenant>"
  setx AZURE_CLIENT_ID     "<appId>"
  setx AZURE_CLIENT_SECRET "<password>"
  ```

---

## PHẦN C — Việc MÌNH (Claude) làm sau khi bạn xong Phần A

Bạn gửi lại mình **4 giá trị (không phải secret)**:
1. `publisherName`  — tên pháp lý đã xác minh (vd: "VGC Group")
2. `endpoint`       — theo region:
   - East US → `https://eus.codesigning.azure.net/`
   - West US 3 → `https://wus3.codesigning.azure.net/`
   - West Central US → `https://wcus.codesigning.azure.net/`
   - North Europe → `https://neu.codesigning.azure.net/`
   - West Europe → `https://weu.codesigning.azure.net/`
3. `codeSigningAccountName` — vd: `vgc-signing`
4. `certificateProfileName` — vd: `vgc-cert-profile`

Mình sẽ thêm khối này vào `package.json` → `build.win`:
```json
"azureSignOptions": {
  "publisherName": "VGC Group",
  "endpoint": "https://eus.codesigning.azure.net/",
  "codeSigningAccountName": "vgc-signing",
  "certificateProfileName": "vgc-cert-profile"
}
```
Rồi `npm run dist` → electron-builder tự gọi signtool + Azure ký **app exe, uninstaller
và web-setup stub**. Mình up bản đã ký lên server + kiểm tra chữ ký
(`signtool verify /pa /v` phải hiện publisher của bạn).

> Lưu ý: gói `.7z` không phải exe nên không ký — nhưng `VGC Browser.exe` BÊN TRONG nó
> đã được ký trước khi đóng gói, nên cài xong app vẫn có chữ ký hợp lệ.

---

## Kết quả mong đợi
- Tải file: SmartScreen hết "nhà phát hành không xác định" (hiện đúng tên bạn).
- Cảnh báo đỏ biến mất (Trusted Signing có uy tín SmartScreen; vài lượt đầu có thể
  còn nhắc nhẹ rồi hết khi tích uy tín).
