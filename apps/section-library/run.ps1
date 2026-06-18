# Section Layout Scanner — Windows launcher
# Run from: C:\joomla-mcp-suite\apps\section-library\
#   .\run.ps1              <- all sites from ../particle-inventory/sites.json
#   .\run.ps1 Trinity      <- filter to one site

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
    python scan.py --site $site
} else {
    Write-Host "`nRunning for all sites..."
    python scan.py
}

Write-Host "`nOutput written to: $PSScriptRoot\output\"
