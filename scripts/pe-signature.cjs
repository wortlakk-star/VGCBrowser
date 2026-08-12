const {
  closeSync,
  constants: fsConstants,
  fstatSync,
  openSync,
  readSync
} = require('fs')

const MAX_HEADER_BYTES = 64 * 1024

function peCertificateTable(filePath) {
  let fd
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 256) return null
    const header = Buffer.alloc(Math.min(stat.size, MAX_HEADER_BYTES))
    const bytesRead = readSync(fd, header, 0, header.length, 0)
    if (bytesRead < 256 || header.readUInt16LE(0) !== 0x5a4d) return null

    const peOffset = header.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset + 24 > bytesRead) return null
    if (header.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return null

    const optionalHeader = peOffset + 24
    const magic = header.readUInt16LE(optionalHeader)
    const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1)
    const securityEntry = dataDirectory + 4 * 8
    if (dataDirectory < optionalHeader || securityEntry + 8 > bytesRead) return null

    const offset = header.readUInt32LE(securityEntry)
    const size = header.readUInt32LE(securityEntry + 4)
    if (offset === 0 && size === 0) return { present: false }
    if (!offset || size < 8 || offset > stat.size || size > stat.size - offset) return null
    return { present: true, offset, size }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function isUnsignedPe(filePath) {
  return peCertificateTable(filePath)?.present === false
}

module.exports = { isUnsignedPe, peCertificateTable }

if (require.main === module) {
  const files = process.argv.slice(2)
  if (!files.length) throw new Error('Cần ít nhất một đường dẫn PE để kiểm tra.')
  for (const file of files) {
    if (!isUnsignedPe(file)) throw new Error(`PE không hợp lệ hoặc không unsigned: ${file}`)
  }
  console.log(`PASS: ${files.length} PE file(s) are unsigned`)
}
