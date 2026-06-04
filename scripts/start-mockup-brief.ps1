# Start the mockup brief builder (port 18304) in a new terminal window.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 18304

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'mockup-brief :$port'; Set-Location '$root\apps\gantry-mcp'; `$env:MOCKUP_BUILDER_PORT='$port'; node mockup-brief-server.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started mockup-brief builder on port $port."
