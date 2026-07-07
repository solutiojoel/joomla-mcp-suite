# Start the sub-agent run dashboard (port 3507) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 3507

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'dashboard :$port'; Set-Location '$root\apps\agents-mcp'; `$env:DASHBOARD_PORT='$port'; npx tsx src/dashboard.ts }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started dashboard on port $port."
Write-Host "Open: http://localhost:$port"
