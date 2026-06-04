# sync-agent-docs.ps1
# Syncs CLAUDE.md and AGENTS.md so both always contain the same instructions.
# Run this after editing either file.
#
# Usage:
#   .\scripts\sync-agent-docs.ps1           # Copies CLAUDE.md → AGENTS.md (default)
#   .\scripts\sync-agent-docs.ps1 -Source agents  # Copies AGENTS.md → CLAUDE.md

param(
    [ValidateSet("claude", "agents")]
    [string]$Source = "claude"
)

$root = Split-Path $PSScriptRoot -Parent
$claudePath = Join-Path $root "CLAUDE.md"
$agentsPath = Join-Path $root "AGENTS.md"

$agentsSyncNote = @"
# Joomla MCP Suite — Agent Instructions

> **Sync note:** This file is kept in sync with ``CLAUDE.md``. If you update one, run ``scripts/sync-agent-docs.ps1`` to update the other, or edit both manually.

---

"@

$claudeSyncNote = @"
# Joomla MCP Suite — Claude Code Instructions

> **Sync note:** This file is kept in sync with ``AGENTS.md``. If you update one, run ``scripts/sync-agent-docs.ps1`` to update the other, or edit both manually.

---

"@

if ($Source -eq "claude") {
    Write-Host "Syncing CLAUDE.md → AGENTS.md..." -ForegroundColor Cyan

    # Read CLAUDE.md, strip the first heading line and optional sync note block
    $content = Get-Content $claudePath -Raw
    # Remove existing header + optional sync note (everything up to the first ---)
    $body = $content -replace '^(?s).*?(?=\n## Platform Overview)', ''

    $output = $agentsSyncNote + $body.TrimStart("`n")
    Set-Content $agentsPath $output -NoNewline
    Write-Host "Done. AGENTS.md updated." -ForegroundColor Green
}
else {
    Write-Host "Syncing AGENTS.md → CLAUDE.md..." -ForegroundColor Cyan

    $content = Get-Content $agentsPath -Raw
    $body = $content -replace '^(?s).*?(?=\n## Platform Overview)', ''

    $output = $claudeSyncNote + $body.TrimStart("`n")
    Set-Content $claudePath $output -NoNewline
    Write-Host "Done. CLAUDE.md updated." -ForegroundColor Green
}
