# Start freshdesk-mcp (port 9303) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 9303

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'freshdesk-mcp :$port'; Set-Location '$root\apps\freshdesk-mcp'; `$env:HTTP_PORT='$port'; node dist/index.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started freshdesk-mcp on port $port."
