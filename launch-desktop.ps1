# Opens the Stremio desktop app on the local dev server (pnpm run start:http).
#
# NO_CORS lets the streaming server accept requests from http://localhost:8080,
# which isn't on its list of allowed websites. While Stremio runs this way, any
# website open on this PC can reach the streaming server, so use it only for
# development and start Stremio normally the rest of the time.

param(
    [string]$WebUiUrl = 'http://localhost:8080/',
    [string]$ShellPath = "$env:LOCALAPPDATA\Programs\Stremio\stremio-shell-ng.exe"
)

if (-not (Test-Path $ShellPath)) {
    Write-Error "Stremio not found at $ShellPath. Pass -ShellPath with the location of stremio-shell-ng.exe."
    exit 1
}

# Check via 127.0.0.1: "localhost" tries IPv6 first, which the dev server doesn't
# listen on, and the fallback can take seconds.
$checkUrl = $WebUiUrl -replace '//localhost', '//127.0.0.1'
try {
    Invoke-WebRequest $checkUrl -UseBasicParsing -TimeoutSec 15 | Out-Null
} catch {
    Write-Error "Nothing is answering at $WebUiUrl. Start the dev server first with: pnpm run start:http"
    exit 1
}

# A running instance would ignore the new arguments, so close it first.
$running = Get-Process stremio-shell-ng, stremio-runtime -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'Closing the running Stremio...'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# Set NO_CORS only for the launched app, then restore this session's value.
$previousNoCors = $env:NO_CORS
$env:NO_CORS = '1'
try {
    Start-Process -FilePath $ShellPath -ArgumentList "--webui-url=$WebUiUrl"
} finally {
    $env:NO_CORS = $previousNoCors
}

Write-Host "Stremio opened on $WebUiUrl"
