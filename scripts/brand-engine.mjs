import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Kiểm tra engine Windows phải chạy trên Windows.')
}

const engineDir = join(process.cwd(), 'engine', 'chromium')
const exe = join(engineDir, 'chrome.exe')
const dll = join(engineDir, 'chrome.dll')
const expectedSigner = (process.env.VGC_WINDOWS_SIGNER_SUBJECT || '').trim()
const allowUnsigned = process.env.VGC_ALLOW_UNSIGNED_BUILD === '1'
if (allowUnsigned && expectedSigner) {
  throw new Error('Không được đặt signer khi đang build unsigned.')
}
if (!allowUnsigned && (!expectedSigner || expectedSigner.length > 1024)) {
  throw new Error('Thiếu VGC_WINDOWS_SIGNER_SUBJECT cho bước branding engine.')
}
if (!existsSync(exe) || !existsSync(dll)) {
  throw new Error('Thiếu chrome.exe hoặc chrome.dll trong engine đã đóng gói.')
}

for (const file of [exe, dll]) {
  const escaped = file.replace(/'/g, "''")
  const signature = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 }
    )
  )
  if (allowUnsigned && (signature.Status !== 'NotSigned' || signature.Subject)) {
    throw new Error(`Engine phải unsigned: ${file}`)
  }
  if (!allowUnsigned && (signature.Status !== 'Valid' || signature.Subject !== expectedSigner)) {
    throw new Error(`Authenticode hoặc nhà phát hành không hợp lệ sau đóng gói: ${file}`)
  }
}

console.log('Engine đã đúng chế độ chữ ký cấu hình trước khi đóng gói.')
