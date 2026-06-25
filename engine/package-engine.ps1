# VGC Core - package the built engine runtime into a .zip for the server.
# Collects only the RUNTIME files from the gn build out dir (not obj/gen/.lib/.pdb)
# and zips them so chrome.exe sits at the zip root. Upload the result to your
# server / Supabase Storage and put its URL in VGC Browser > Settings > Engine.
$ErrorActionPreference = 'Stop'
$src = 'D:\chromium\src\out\Default'
$stage = 'D:\chromium\engine-dist\chromium'
$zip = 'D:\chromium\engine-dist\vgc-core-149.zip'

if (-not (Test-Path (Join-Path $src 'chrome.exe'))) {
  Write-Error "chrome.exe not found in $src - build first."
  exit 1
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Runtime file extensions at the build root.
# NOTE: *.manifest is REQUIRED — chrome.exe depends on a SxS assembly named after the
# version (e.g. 149.0.7827.54.manifest, which points at chrome_elf.dll). Without it the
# engine dies on launch with "side-by-side configuration is incorrect" (0x490 / SxS).
$exts = '*.exe', '*.dll', '*.pak', '*.bin', '*.dat', '*.manifest'
foreach ($e in $exts) {
  Get-ChildItem -Path $src -Filter $e -File -ErrorAction SilentlyContinue |
    Copy-Item -Destination $stage -Force
}

# locales (per-language .pak) and resources folders if present.
foreach ($dir in 'locales', 'resources', 'MEIPreload') {
  $p = Join-Path $src $dir
  if (Test-Path $p) { Copy-Item $p -Destination $stage -Recurse -Force }
}

$sizeMB = [math]::Round(((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "Staged runtime: $sizeMB MB"

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Write-Host "Zipping to $zip ..."
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$zipMB = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Done: $zip ($zipMB MB)"
Write-Host "Upload this .zip to your server, then set its URL in Settings > Engine."
