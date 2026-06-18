# Start mockup-analyzer MCP server (port 9305) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 9305

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'mockup-analyzer :$port'; Set-Location '$root\apps\mockup-analyzer'; `$env:HTTP_PORT='$port'; python server.py }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started mockup-analyzer on port $port."
Write-Host "Orchestrator will discover its tools automatically via reload_tools."
