# VGC Browser - one-command release.
# Usage:   .\release.ps1
# After you edit code, run this. It will:
#   1) bump the patch version in package.json (e.g. 0.1.31 -> 0.1.32)
#   2) build the Windows installer (npm run dist)
#   3) deploy to vgcbrowser.com/dl (deploy.ps1)
# Result: every installed app auto-updates to the new version.
# ASCII-only on purpose (Windows PowerShell mis-reads UTF-8 in .ps1).

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# 1) Bump patch version (only the top-level "version" line in package.json)
$pkgPath = Join-Path $root 'package.json'
$raw = Get-Content $pkgPath -Raw
$rx = [regex]'("version":\s*")(\d+)\.(\d+)\.(\d+)(")'
$m = $rx.Match($raw)
if (-not $m.Success) { Write-Host "Cannot find version in package.json" -ForegroundColor Red; exit 1 }
$newver = "{0}.{1}.{2}" -f $m.Groups[2].Value, $m.Groups[3].Value, ([int]$m.Groups[4].Value + 1)
$raw = $rx.Replace($raw, ('${1}' + $newver + '${5}'), 1)
[System.IO.File]::WriteAllText($pkgPath, $raw)
Write-Host "Version bumped -> $newver" -ForegroundColor Cyan

# 2) Build (close any running app first so out/ is not locked; clean old artifacts)
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$releaseDir = Join-Path $root 'release'
if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force }
Write-Host "Building installer..." -ForegroundColor Cyan
npm run dist
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }

# 3) Deploy to web
& (Join-Path $root 'deploy.ps1')
