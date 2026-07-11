# run-e2e.ps1 - stands up a FRESH instance of the real app and runs Playwright
# against it, then tears everything down. Run from the repo root:
#
#   powershell -ExecutionPolicy Bypass -File ./e2e/run-e2e.ps1
#
# Requires port 8090 (PocketBase) and 3000 (static frontend) to be free -
# stop any running `npm start` dev instance first. This intentionally reuses
# the app's real, hardcoded ports (public/config.js points the frontend at
# 127.0.0.1:8090) rather than an alternate port, so the app under test is
# byte-for-byte the same app a user runs, not a special e2e-only config.
#
# Errors during setup (as opposed to a failing test) are prefixed "SETUP:" so
# a future gate script can tell "infra never came up" apart from "a test
# actually failed" (see Step 2b).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$seed = Join-Path $root "e2e\seed_pb_data"
$tmp = Join-Path $env:TEMP "pb_e2e_$(Get-Random)"

if (-not (Test-Path $seed)) {
  throw "SETUP: no seed data at $seed - see e2e/README.md to build it."
}

Copy-Item -Recurse $seed $tmp

$pbLog = Join-Path $tmp "pocketbase.log"
$webLog = Join-Path $tmp "serve.log"

$pb = $null
$web = $null
try {
  # Everything in this inner try is "stand the app up" — any failure here,
  # anticipated or not (missing binary, Start-Process itself throwing,
  # whatever), is an infra problem, not a code problem. Catch-all and
  # re-prefix with SETUP: rather than only tagging the specific failure
  # modes we thought to anticipate (e.g. the readiness-timeout below) —
  # otherwise an unanticipated setup error reads as a "real" test failure
  # and the belt wrongly routes it back to the implement agent to "fix"
  # code that was never broken.
  try {
    # -NoNewWindow (not -WindowStyle Hidden): Hidden needs a window station,
    # which isn't guaranteed to exist when this runs under automation rather
    # than an interactive desktop session, and silently hangs Start-Process
    # when it doesn't. -NoNewWindow has no such requirement.
    $pb = Start-Process (Join-Path $root "pocketbase.exe") `
      -ArgumentList "serve", "--http=127.0.0.1:8090", "--dir=$tmp" `
      -PassThru -NoNewWindow -RedirectStandardOutput $pbLog -RedirectStandardError "$pbLog.err"
    # npx resolves to npx.cmd on Windows; Start-Process launches processes via
    # CreateProcess directly (no PATHEXT/shim resolution the way a shell or
    # plain PowerShell command invocation gets), so a bare "npx" here fails
    # with "%1 is not a valid Win32 application." Routing through cmd.exe /c
    # lets cmd resolve the shim itself, same fix pipeline/run.ts uses for the
    # claude CLI's own .cmd shim on Windows.
    $publicDir = Join-Path $root "public"
    $web = Start-Process cmd.exe `
      -ArgumentList "/c", "npx --yes serve -l 3000 `"$publicDir`"" `
      -PassThru -NoNewWindow -RedirectStandardOutput $webLog -RedirectStandardError "$webLog.err"

    # WAIT for readiness, do not just sleep. Poll both until they answer.
    foreach ($url in @("http://127.0.0.1:8090/api/health", "http://127.0.0.1:3000")) {
      $ok = $false
      for ($i = 0; $i -lt 30; $i++) {
        try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true; break }
        catch { Start-Sleep -Milliseconds 500 }
      }
      if (-not $ok) { throw "SETUP: $url never became ready" }
    }
  } catch {
    $msg = $_.Exception.Message
    if ($msg -notmatch '^SETUP:') { $msg = "SETUP: $msg" }
    throw $msg
  }

  Push-Location $root
  try {
    npx playwright test
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
}
finally {
  # taskkill /T, not Stop-Process: $web is cmd.exe (see the npx launch above),
  # and Stop-Process only kills that wrapper, orphaning the real node/serve
  # process underneath it — which then keeps holding port 3000 forever.
  # /T recurses the whole tree. Harmless to use on $pb too (no children).
  if ($pb) { taskkill /pid $pb.Id /T /F 2>$null | Out-Null }
  if ($web) { taskkill /pid $web.Id /T /F 2>$null | Out-Null }
  Start-Sleep -Milliseconds 300  # let file handles release before deleting
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
exit $code
