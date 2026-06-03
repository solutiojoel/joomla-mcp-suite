# Start joomla-mcp (port 9300) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 9300

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'joomla-mcp :$port'; Set-Location '$root\apps\joomla-mcp'; `$env:HTTP_PORT='$port'; node dist/index.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started joomla-mcp on port $port."
