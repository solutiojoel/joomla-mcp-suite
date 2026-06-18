# Particle Library Builder — Windows launcher
# Run from: C:\joomla-mcp-suite\apps\particle-library\
#   .\run.ps1              <- all sites
#   .\run.ps1 StCats       <- one site (name filter)

$site = $args[0]

Set-Location $PSScriptRoot

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "python not found on PATH"; exit 1
}

Write-Host "Installing/verifying dependencies..."
python -m pip install playwright --quiet
python -m playwright install chromium

if ($site) {
    Write-Host "`nRunning for site: $site"
    python build.py --site $site
} else {
    Write-Host "`nRunning for all sites..."
    python build.py
}

Write-Host "`nOutput written to: $PSScriptRoot\output\"
