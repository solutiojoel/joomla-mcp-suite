# Start gantry-mcp (port 9301) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 9301

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'gantry-mcp :$port'; Set-Location '$root\apps\gantry-mcp'; `$env:HTTP_PORT='$port'; node mcp-server.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started gantry-mcp on port $port."
