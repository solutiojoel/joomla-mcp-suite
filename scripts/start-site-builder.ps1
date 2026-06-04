# Start the site-builder server (port 18303) in a new terminal window.
# Requires joomla-mcp (9300) and gantry-mcp (9301) to already be running.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port        = 18303
$gantryPort  = 9301
$joomlaPort  = 9300

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'site-builder :$port'; Set-Location '$root\apps\gantry-mcp'; `$env:SITE_BUILDER_PORT='$port'; `$env:GANTRY_MCP_URL='http://127.0.0.1:$gantryPort/mcp'; `$env:JOOMLA_MCP_URL='http://127.0.0.1:$joomlaPort/mcp'; node site-builder-server.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started site-builder on port $port."
