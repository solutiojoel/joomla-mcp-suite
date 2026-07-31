# Switch the `joomla-suite` MCP registration between the local stack and Replit.
#
#   .\scripts\mcp-target.ps1 local     -> http://127.0.0.1:9302/mcp   (start-all.ps1 must be running)
#   .\scripts\mcp-target.ps1 replit    -> https://shannon-mcp.replit.app/mcp
#   .\scripts\mcp-target.ps1 show      -> print the current registration
#
# Local hosting exists to dodge the Joomla host's throttling of cloud egress IPs.
# See .agents/memory/joomla-host-throttling.md. Restart Claude Code after switching —
# an in-session MCP connection does not re-resolve its URL.
#
# Credentials come from the repo-root .env (gitignored), or from the real
# environment, which wins. Never hardcode a token in this file.
#
# The two targets need DIFFERENT tokens, because they authenticate differently:
#
#   local   config/users.json is present, so the orchestrator uses the per-user
#           registry and ORCHESTRATOR_TOKEN is ignored -> use MCP_TOKEN_JEREMY.
#   replit  config/users.json is gitignored, so the deployment never has one.
#           The orchestrator falls back to single-token mode -> use
#           ORCHESTRATOR_TOKEN, which must match the Replit secret.
#
# Verified 2026-07-31: MCP_TOKEN_JEREMY returns 401 against Replit, and
# ORCHESTRATOR_TOKEN returns 200. Do not collapse these back into one variable.
#
#   REPLIT_BYPASS_TOKEN   the Replit project-protection bypass JWT (replit target only)

param(
    [Parameter(Position = 0)]
    [ValidateSet('local', 'replit', 'show')]
    [string]$Target = 'show',

    # Which .env key holds your local registry token. Each user has their own.
    [string]$TokenVar = 'MCP_TOKEN_JEREMY',

    # Which .env key holds the Replit single-token secret. Shared, not per-user.
    [string]$ReplitTokenVar = 'ORCHESTRATOR_TOKEN'
)

$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'

# Parse KEY=VALUE lines from the repo-root .env. Comments and blanks are skipped.
function Read-DotEnv([string]$Path) {
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $split = $trimmed.IndexOf('=')
        if ($split -lt 1) { continue }
        $key = $trimmed.Substring(0, $split).Trim()
        $val = $trimmed.Substring($split + 1).Trim().Trim('"').Trim("'")
        $map[$key] = $val
    }
    return $map
}

$dotenv = Read-DotEnv $envPath

# The real environment beats .env — the same precedence @solutio/env applies.
function Get-Secret([string]$Name) {
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnv) { return $fromEnv }
    if ($dotenv.ContainsKey($Name) -and $dotenv[$Name]) { return $dotenv[$Name] }
    return $null
}

$localUrl = 'http://127.0.0.1:9302/mcp'

if ($Target -eq 'show') {
    claude mcp get joomla-suite
    return
}

$tokenVarForTarget = if ($Target -eq 'local') { $TokenVar } else { $ReplitTokenVar }

$token = Get-Secret $tokenVarForTarget
if (-not $token) {
    Write-Error "$tokenVarForTarget is not set. Add it to $envPath or export it, then run this script again."
    exit 1
}

if ($Target -eq 'local') {
    $url = $localUrl

    $tcp = [System.Net.Sockets.TcpClient]::new()
    try {
        $tcp.Connect('127.0.0.1', 9302)
        $tcp.Close()
    } catch {
        Write-Warning "Nothing is listening on 127.0.0.1:9302. Run .\scripts\start-all.ps1 first."
    }
} else {
    $bypass = Get-Secret 'REPLIT_BYPASS_TOKEN'
    if (-not $bypass) {
        Write-Error "REPLIT_BYPASS_TOKEN is not set. Add it to $envPath or export it, then run this script again."
        exit 1
    }
    $url = "https://shannon-mcp.replit.app/mcp?project-protection-bypass=$bypass"
}

try { claude mcp remove joomla-suite -s local | Out-Null } catch { }
claude mcp add --transport http joomla-suite $url --header "Authorization: Bearer $token"

Write-Host ""
Write-Host "joomla-suite now points at the $Target stack (auth: $tokenVarForTarget)." -ForegroundColor Green
if ($Target -eq 'local') {
    Write-Host "  $url"
} else {
    Write-Host "  https://shannon-mcp.replit.app/mcp?project-protection-bypass=<redacted>"
}
Write-Host ""
Write-Host "Restart Claude Code so the session picks up the new URL." -ForegroundColor Yellow
