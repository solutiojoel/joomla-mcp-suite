# Rebuild joomla-mcp from TypeScript source.
# Run this manually after pulling changes or when the auto-build hook isn't available.
#
# After running:
#   1. Restart the joomla-mcp terminal window (port 9300)
#   2. Ask Claude to call reload_tools to refresh the orchestrator's tool list

$root = Split-Path -Parent $PSScriptRoot

Write-Host "Building joomla-mcp..."
Push-Location "$root\apps\joomla-mcp"
npm run build
$exitCode = $LASTEXITCODE
Pop-Location

if ($exitCode -ne 0) {
    Write-Host "Build FAILED." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Build complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart the joomla-mcp terminal window (port 9300)"
Write-Host "  2. In Claude, call reload_tools to refresh the orchestrator's tool list"
