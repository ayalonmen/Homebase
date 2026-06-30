# start.ps1 — one-command dev orchestration for Windows.
#
#   1. Start PocketBase (REST API) on 127.0.0.1:8090
#   2. Provision + seed via setup.js (waits for the API itself)
#   3. Serve the static frontend on 127.0.0.1:5173
#
# Admin creds: set $env:PB_ADMIN_EMAIL / $env:PB_ADMIN_PASSWORD to override the
# dev fallback (admin@homebase.dev / devpassword1234).

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$pb = Join-Path $root 'pocketbase.exe'
if (-not (Test-Path $pb)) { Write-Error "pocketbase.exe not found in $root"; exit 1 }

Write-Host "`n▸ Starting PocketBase API (127.0.0.1:8090) …" -ForegroundColor Cyan
$api = Start-Process -FilePath $pb -ArgumentList 'serve','--http=127.0.0.1:8090' -PassThru -NoNewWindow

try {
  Write-Host "▸ Provisioning database (node setup.js) …" -ForegroundColor Cyan
  node setup.js
  if ($LASTEXITCODE -ne 0) { throw "setup.js failed (exit $LASTEXITCODE)" }

  Write-Host "`n▸ Serving frontend at http://127.0.0.1:5173 …" -ForegroundColor Cyan
  Write-Host "  (Ctrl+C to stop; PocketBase will be stopped too.)`n" -ForegroundColor DarkGray
  npx --yes serve -l 5173 public
}
finally {
  Write-Host "`n▸ Stopping PocketBase …" -ForegroundColor Cyan
  if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
}
