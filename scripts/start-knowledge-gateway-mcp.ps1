# Start knowledge-gateway-mcp (port 9306) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 9306

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'knowledge-gateway-mcp :$port'; Set-Location '$root\apps\knowledge-gateway-mcp'; `$env:HTTP_PORT='$port'; node dist/index.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started knowledge-gateway-mcp on port $port."
