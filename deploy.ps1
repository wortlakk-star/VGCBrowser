# VGC Browser - deploy the latest build to vgcbrowser.com/dl
# Usage:   .\deploy.ps1
# Uploads Setup .exe + .7z + latest.yml from release\nsis-web to the website.
# No password is stored here. Uses your SSH key if present, otherwise ssh asks
# for the password. ASCII-only on purpose (Windows PowerShell mis-reads UTF-8).

$ErrorActionPreference = 'Stop'

$SSH_HOST = '212.85.28.201'
$SSH_PORT = '65002'
$SSH_USER = 'u469659181'
# vgcbrowser.com is a Hostinger addon domain -> served from these folders:
$REMOTE   = 'domains/vgcbrowser.com/public_html/dl'
$WEBROOT  = 'domains/vgcbrowser.com/public_html'

$dir = Join-Path $PSScriptRoot 'release\nsis-web'
if (-not (Test-Path $dir)) {
  Write-Host "No build found. Run 'npm run dist' first." -ForegroundColor Yellow
  exit 1
}

$setup = Get-ChildItem $dir -Filter 'VGC-Browser-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$pkg   = Get-ChildItem $dir -Filter 'vgc-browser-*-x64.nsis.7z' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$yml   = Join-Path $dir 'latest.yml'

$files = @()
if ($setup) { $files += $setup.FullName }
if ($pkg)   { $files += $pkg.FullName }
if (Test-Path $yml) { $files += $yml }

if ($files.Count -eq 0) { Write-Host "No build files in $dir" -ForegroundColor Red; exit 1 }

Write-Host "Uploading to ${SSH_USER}@${SSH_HOST}:$REMOTE/" -ForegroundColor Cyan
$files | ForEach-Object { Write-Host "  $_" }

ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE"
scp -P $SSH_PORT $files "${SSH_USER}@${SSH_HOST}:$REMOTE/"

# Also upload the landing page (its Download button auto-reads latest.yml)
$landing = Join-Path $PSScriptRoot 'web\index.html'
if (Test-Path $landing) {
  Write-Host "Uploading landing page (web/index.html)" -ForegroundColor Cyan
  scp -P $SSH_PORT $landing "${SSH_USER}@${SSH_HOST}:$WEBROOT/index.html"
}

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "Done. Check: https://vgcbrowser.com/dl/$($setup.Name)" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "scp failed (exit $LASTEXITCODE)" -ForegroundColor Red
}
