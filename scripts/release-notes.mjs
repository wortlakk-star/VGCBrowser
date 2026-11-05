// Sinh resources/release-notes.md cho đúng version trong package.json từ src/shared/changelog.json.
// electron-builder chép file này vào latest.yml (releaseNotes) → app cũ đọc được trước khi cập nhật.
// Dừng build nếu chưa ghi nhật ký cho version này, để không bản nào phát hành mà nhân viên không biết thay đổi gì.
import { readFileSync, writeFileSync } from 'fs'

const root = new URL('..', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const { entries } = JSON.parse(readFileSync(new URL('src/shared/changelog.json', root), 'utf8'))
const e = entries.find((x) => x.version === version)
if (!e || !(e.fixed.length || e.added.length || e.action.length)) {
  console.error(`::error::Thiếu nhật ký thay đổi cho ${version} trong src/shared/changelog.json`)
  process.exit(1)
}
const sec = (title, list) => (list.length ? `${title}\n${list.map((l) => `- ${l}`).join('\n')}\n` : '')
const md = [sec('Đã sửa lỗi:', e.fixed), sec('Có gì mới:', e.added), sec('Nhân viên cần làm:', e.action)]
  .filter(Boolean)
  .join('\n')
writeFileSync(new URL('resources/release-notes.md', root), md)
console.log(`release-notes.md cho ${version}:\n${md}`)
