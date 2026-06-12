# Start ftp-mcp (port 9304) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 9304

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'ftp-mcp :$port'; Set-Location '$root\apps\ftp-mcp'; `$env:HTTP_PORT='$port'; node dist/index.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started ftp-mcp on port $port."
