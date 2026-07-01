# start.ps1 - one-command dev orchestration for Windows.
#
#   1. Start PocketBase (REST API) on 127.0.0.1:8090
#   2. Provision + seed via setup.js - but ONLY on the first run (or with -Reset),
#      because setup.js DROPS + recreates every collection. Re-running it on every
#      launch would wipe the data you added. Normal restarts keep your data.
#   3. Serve the static frontend on 127.0.0.1:3000
#
#   Reset to the clean seed on purpose:  npm start -- -Reset   (or: npm run reset)
#
# Admin creds: set $env:PB_ADMIN_EMAIL / $env:PB_ADMIN_PASSWORD to override the
# dev fallback (admin@homebase.dev / devpassword1234).
#
# NOTE: kept ASCII-only on purpose - Windows PowerShell 5.1 mis-decodes BOM-less
# UTF-8, so non-ASCII characters here would break parsing.

param([switch]$Reset)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$pb = Join-Path $root 'pocketbase.exe'
if (-not (Test-Path $pb)) { Write-Error "pocketbase.exe not found in $root. Download it per the README."; exit 1 }

Write-Host "`n> Starting PocketBase API (127.0.0.1:8090) ..." -ForegroundColor Cyan
$api = Start-Process -FilePath $pb -ArgumentList 'serve', '--http=127.0.0.1:8090' -PassThru -NoNewWindow

try {
  # Wait for the API to answer before deciding anything.
  $up = $false
  for ($i = 0; $i -lt 50; $i++) {
    try { $null = Invoke-RestMethod 'http://127.0.0.1:8090/api/health' -TimeoutSec 2; $up = $true; break }
    catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $up) { throw "PocketBase did not become healthy in time." }

  # Has the DB already been provisioned? (Does the tasks collection exist?)
  $provisioned = $false
  try { $null = Invoke-RestMethod 'http://127.0.0.1:8090/api/collections/tasks/records?perPage=1' -TimeoutSec 3; $provisioned = $true }
  catch { $provisioned = $false }

  if ($Reset -or -not $provisioned) {
    if ($Reset) { Write-Host "> -Reset requested - dropping, recreating & reseeding (node setup.js) ..." -ForegroundColor Yellow }
    else { Write-Host "> First run - provisioning database (node setup.js) ..." -ForegroundColor Cyan }
    node setup.js
    if ($LASTEXITCODE -ne 0) { throw "setup.js failed (exit $LASTEXITCODE)" }
  }
  else {
    Write-Host "> Database already provisioned - keeping your data." -ForegroundColor DarkGray
    Write-Host "  (To wipe & reseed on purpose: npm start -- -Reset  or  npm run reset)" -ForegroundColor DarkGray
  }

  Write-Host "`n> Serving frontend at http://127.0.0.1:3000 ..." -ForegroundColor Cyan
  Write-Host "  (Ctrl+C to stop; PocketBase will be stopped too.)`n" -ForegroundColor DarkGray
  npx --yes serve -l 3000 public
}
finally {
  Write-Host "`n> Stopping PocketBase ..." -ForegroundColor Cyan
  if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
}
