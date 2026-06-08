# VGC Browser - deploy the latest build to vgcbrowser.com/dl
# Usage:   .\deploy.ps1
# Finds the newest installer ANYWHERE under release\ (works for both the
# self-contained 'nsis' build [release\*.exe] and the older 'nsis-web' build
# [release\nsis-web\*.exe]) and uploads it + latest.yml (+ .blockmap / .7z if
# present) to the website. No password stored here. Uses your SSH key if present,
# otherwise ssh asks for the password. ASCII-only (Windows PowerShell mis-reads UTF-8).

$ErrorActionPreference = 'Stop'

$SSH_HOST = '212.85.28.201'
$SSH_PORT = '65002'
$SSH_USER = 'u469659181'
# vgcbrowser.com is a Hostinger addon domain -> served from these folders:
$REMOTE   = 'domains/vgcbrowser.com/public_html/dl'
$WEBROOT  = 'domains/vgcbrowser.com/public_html'

$rel = Join-Path $PSScriptRoot 'release'
if (-not (Test-Path $rel)) {
  Write-Host "No build found. Run 'npm run dist' first." -ForegroundColor Yellow
  exit 1
}

# Newest installer anywhere under release\ (skip win-unpacked\)
$setup = Get-ChildItem $rel -Recurse -Filter 'VGC-Browser-Setup-*.exe' -File |
  Where-Object { $_.DirectoryName -notlike '*win-unpacked*' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Write-Host "No installer (.exe) found under release\" -ForegroundColor Red; exit 1 }

$dir = $setup.DirectoryName
$files = @($setup.FullName)
$yml = Join-Path $dir 'latest.yml'
if (Test-Path $yml) { $files += $yml }
$bm = "$($setup.FullName).blockmap"
if (Test-Path $bm) { $files += $bm }
$pkg = Get-ChildItem $dir -Filter '*.nsis.7z' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($pkg) { $files += $pkg.FullName }

Write-Host "Uploading to ${SSH_USER}@${SSH_HOST}:$REMOTE/" -ForegroundColor Cyan
$files | ForEach-Object { Write-Host ("  {0}  ({1} MB)" -f (Split-Path $_ -Leaf), [math]::Round((Get-Item $_).Length/1MB,1)) }

ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE"
scp -P $SSH_PORT $files "${SSH_USER}@${SSH_HOST}:$REMOTE/"
$scpExit = $LASTEXITCODE

# Also upload the landing page (its Download button auto-reads latest.yml)
$landing = Join-Path $PSScriptRoot 'web\index.html'
if (Test-Path $landing) {
  Write-Host "Uploading landing page (web/index.html)" -ForegroundColor Cyan
  scp -P $SSH_PORT $landing "${SSH_USER}@${SSH_HOST}:$WEBROOT/index.html"
}

if ($scpExit -eq 0) {
  Write-Host ""
  Write-Host "Done. Check: https://vgcbrowser.com/dl/$($setup.Name)" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "scp failed (exit $scpExit)" -ForegroundColor Red
}
