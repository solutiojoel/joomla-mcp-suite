# Start agents-mcp (port 3506) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 3506

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'agents-mcp :$port'; Set-Location '$root\apps\agents-mcp'; `$env:HTTP_PORT='$port'; npx tsx src/index.ts }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started agents-mcp on port $port."
