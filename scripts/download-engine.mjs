console.error(
  'download-engine đã bị vô hiệu hóa: engine Chromium bên thứ ba không có VGC patches sẽ làm lộ fingerprint. ' +
    'Dùng npm run fetch-engine với VGC_ENGINE_SHA256 đã ghim.'
)
process.exit(1)
