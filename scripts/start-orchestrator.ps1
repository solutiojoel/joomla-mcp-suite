# Start the orchestrator (port 9302) in a new terminal window.
# Requires joomla-mcp (9300) and gantry-mcp (9301) to already be running.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 9302

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'orchestrator :$port'; Set-Location '$root\apps\joomla-orchestrator'; `$env:HTTP_PORT='$port'; node orchestrator.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started orchestrator on port $port."
Write-Host "Claude Desktop connects via: http://localhost:$port/mcp"
