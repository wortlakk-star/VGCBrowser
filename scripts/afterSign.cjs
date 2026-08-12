const { execFileSync } = require('child_process')
const { join } = require('path')
const { createReadStream, readFileSync } = require('fs')
const { createHash } = require('crypto')
const { isUnsignedPe } = require('./pe-signature.cjs')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename
    const appPath = join(context.appOutDir, `${appName}.app`)
    const verify = () =>
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
        stdio: 'inherit'
      })
    try {
      verify()
    } catch {
      // Apple Silicon still requires a coherent code seal for an unsigned release.
      // Ad-hoc signing adds no publisher identity and needs no certificate.
      execFileSync(
        '/usr/bin/codesign',
        ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
        { stdio: 'inherit' }
      )
      verify()
    }
  } else if (context.electronPlatformName === 'win32') {
    const appExe = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
    const engineExe = join(context.appOutDir, 'resources', 'engine', 'chromium', 'chrome.exe')
    const engineDll = join(context.appOutDir, 'resources', 'engine', 'chromium', 'chrome.dll')
    const expectedSigner = (process.env.VGC_WINDOWS_SIGNER_SUBJECT || '').trim()
    const allowUnsigned = process.env.VGC_ALLOW_UNSIGNED_BUILD === '1'
    if (allowUnsigned && expectedSigner) {
      throw new Error('Không được đặt signer khi đang build unsigned.')
    }
    if (!allowUnsigned && (!expectedSigner || expectedSigner.length > 1024)) {
      throw new Error('Thiếu VGC_WINDOWS_SIGNER_SUBJECT cho release đã ký.')
    }
    const childEnv = { ...process.env }
    delete childEnv.PSModulePath
    const signature = (file) => {
      if (allowUnsigned) return { Status: isUnsignedPe(file) ? 'NotSigned' : 'Invalid', Subject: '' }
      const escaped = file.replace(/'/g, "''")
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`
        ],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024, env: childEnv }
      )
      return JSON.parse(raw)
    }
    const appSignature = signature(appExe)
    const release = JSON.parse(
      readFileSync(join(context.packager.projectDir, 'src', 'shared', 'engine-release.json'), 'utf8')
    )
    const escapedEngine = engineExe.replace(/'/g, "''")
    const engineVersion = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${escapedEngine}').VersionInfo.ProductVersion`
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024, env: childEnv }
    ).trim()
    if (engineVersion !== release.chromeVersion) {
      throw new Error(`Engine ${engineVersion || '<unknown>'} không khớp ${release.chromeVersion}`)
    }
    const fileHash = (file) =>
      new Promise((resolveHash, reject) => {
        const hash = createHash('sha256')
        createReadStream(file)
          .on('data', (chunk) => hash.update(chunk))
          .on('error', reject)
          .on('end', () => resolveHash(hash.digest('hex')))
      })
    if (
      release.windowsSigning !== (allowUnsigned ? 'unsigned' : 'signed') ||
      (await fileHash(engineExe)) !== release.windowsFiles?.['chrome.exe'] ||
      (await fileHash(engineDll)) !== release.windowsFiles?.['chrome.dll']
    ) {
      throw new Error('Hash file hoặc chế độ chữ ký engine không khớp manifest.')
    }
    const signatures = [
      [appExe, appSignature],
      [engineExe, signature(engineExe)],
      [engineDll, signature(engineDll)]
    ]
    for (const [file, fileSignature] of signatures) {
      if (allowUnsigned) {
        if (fileSignature.Status !== 'NotSigned' || fileSignature.Subject) {
          throw new Error(`Release phải unsigned hoàn toàn: ${file}`)
        }
        continue
      }
      if (
        appSignature.Status !== 'Valid' ||
        fileSignature.Status !== 'Valid' ||
        appSignature.Subject !== expectedSigner ||
        fileSignature.Subject !== expectedSigner
      ) {
        throw new Error(`File không cùng nhà phát hành Authenticode với ứng dụng: ${file}`)
      }
    }
  }
}
