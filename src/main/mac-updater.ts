// ── VGC Browser — tự cập nhật trên macOS (app chưa ký Apple) ──────────────────────
// Bộ cập nhật chuẩn của macOS (Squirrel.Mac qua electron-updater) chỉ cài bản có chữ ký Apple, nên
// trước đây bản Mac chỉ mở trang web cho tải tay. Ở đây tự làm: đọc latest-mac.yml, tải .zip, kiểm
// SHA-512 khớp tuyệt đối, giải nén, và lúc thoát app thì một script nhỏ thay app trong /Applications
// (hỏng giữa chừng → trả bản cũ về) rồi mở lại. Không ghi được thư mục chứa app → quay về tải web.
import { app } from 'electron'
import { spawn, execFile } from 'child_process'
import { createHash } from 'crypto'
import { accessSync, constants as fsConstants, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const FEED = 'https://vgcbrowser.com/dl/'

export interface MacUpdateInfo {
  version: string
  zipUrl: string
  sha512: string
}

/** Thư mục .app đang chạy (…/VGC Browser.app), null nếu không xác định được. */
function currentBundle(): string | null {
  const exe = app.getPath('exe') // …/VGC Browser.app/Contents/MacOS/VGC Browser
  const bundle = dirname(dirname(dirname(exe)))
  return bundle.endsWith('.app') ? bundle : null
}

/** Có tự thay app được không (đúng macOS, app đã đóng gói, ghi được thư mục chứa app). */
export function canSelfUpdate(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  const b = currentBundle()
  if (!b) return false
  try {
    accessSync(dirname(b), fsConstants.W_OK)
    accessSync(b, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/** Đọc latest-mac.yml: bản mới hơn bản đang chạy → thông tin tải, ngược lại null. */
export async function macLatest(): Promise<MacUpdateInfo | null> {
  const r = await fetch(`${FEED}latest-mac.yml`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`latest-mac.yml HTTP ${r.status}`)
  const y = await r.text()
  const version = /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(y)?.[1]
  if (!version || !newer(version, app.getVersion())) return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const re = new RegExp(`-\\s+url:\\s*(\\S*-mac-${arch}\\.zip)\\s*\\n\\s+sha512:\\s*(\\S+)`)
  const m = re.exec(y)
  if (!m) throw new Error(`latest-mac.yml không có bản .zip cho ${arch}`)
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(m[1])) throw new Error('Tên file cập nhật không hợp lệ')
  return { version, zipUrl: `${FEED}${m[1]}`, sha512: m[2] }
}

function stagingDir(): string {
  return join(app.getPath('userData'), 'update-staging')
}

let staged: { version: string; app: string } | null = null
export function stagedMacUpdate(): { version: string; app: string } | null {
  return staged
}

/** Tải + kiểm SHA-512 + giải nén bản mới vào thư mục chờ. onProgress: 0..100. */
export async function macDownload(info: MacUpdateInfo, onProgress: (pct: number) => void): Promise<void> {
  const dir = stagingDir()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const zip = join(dir, 'update.zip')
  const r = await fetch(info.zipUrl, { cache: 'no-store' })
  if (!r.ok || !r.body) throw new Error(`Tải bản cập nhật lỗi HTTP ${r.status}`)
  const total = Number(r.headers.get('content-length') ?? 0)
  const hash = createHash('sha512')
  const out = createWriteStream(zip, { mode: 0o600 })
  let got = 0
  let last = -1
  const reader = r.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
    got += value.length
    if (!out.write(value)) await new Promise<void>((res) => out.once('drain', () => res()))
    const pct = total ? Math.floor((got / total) * 100) : 0
    if (pct !== last) {
      last = pct
      onProgress(pct)
    }
  }
  await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())))
  if (hash.digest('base64') !== info.sha512) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error('Bản tải về không khớp SHA-512 — không cài.')
  }
  const ex = join(dir, 'app')
  mkdirSync(ex, { mode: 0o700 })
  await new Promise<void>((res, rej) =>
    execFile('/usr/bin/ditto', ['-x', '-k', zip, ex], (e) => (e ? rej(new Error(`Giải nén lỗi: ${e.message}`)) : res()))
  )
  rmSync(zip, { force: true })
  const bundleName = currentBundle()?.split('/').pop() ?? 'VGC Browser.app'
  const appPath = join(ex, bundleName)
  if (!existsSync(join(appPath, 'Contents', 'MacOS'))) throw new Error('Bản cập nhật thiếu nội dung app')
  staged = { version: info.version, app: appPath }
}

/** Gọi lúc app thoát: chạy script thay app (chờ app tắt hẳn → đổi → mở lại nếu relaunch). */
export function macInstallOnQuit(relaunch: boolean): boolean {
  const s = staged
  const bundle = currentBundle()
  if (!s || !bundle) return false
  const script = join(stagingDir(), 'install.sh')
  writeFileSync(
    script,
    `#!/bin/sh
# Chờ VGC Browser tắt hẳn rồi thay bản mới; hỏng giữa chừng thì trả bản cũ về.
PID="$1"; OLD="$2"; NEW="$3"; RELAUNCH="$4"
for i in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
BAK="$OLD.dang-cap-nhat"
rm -rf "$BAK"
mv "$OLD" "$BAK" || exit 1
if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else rm -rf "$OLD"; mv "$BAK" "$OLD"; fi
xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$OLD"
exit 0
`,
    { mode: 0o700 }
  )
  const child = spawn('/bin/sh', [script, String(process.pid), bundle, s.app, relaunch ? '1' : '0'], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  })
  child.unref()
  return true
}
