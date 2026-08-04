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
# Windows casing gotcha: `claude mcp add -s local` writes the project entry under
# whichever casing of the repo path (C:/... or c:/...) the `claude` CLI resolves at
# invocation time, but ~/.claude.json can hold BOTH casings as separate project keys
# (VS Code vs. terminal sessions resolve them differently). This script mirrors the
# joomla-suite entry across every casing variant it finds, so switching never leaves
# one session silently bound to the stale target.
#
# Credentials come from the repo-root .env (gitignored), or from the real
# environment, which wins. Never hardcode a token in this file.
#
# Both targets now use your per-user token, because both run the user registry:
#
#   local   reads config/users.json from disk.
#   replit  reads the same registry from the ORCHESTRATOR_USERS_JSON secret,
#           because config/users.json is gitignored and never deploys.
#
# A loaded registry replaces single-token mode outright, so ORCHESTRATOR_TOKEN
# is ignored on both. It stays in .env only as the fallback that takes over if
# the registry fails to load. To reach a deployment that has no registry secret
# yet, run: .\scripts\mcp-target.ps1 replit -ReplitTokenVar ORCHESTRATOR_TOKEN
#
#   REPLIT_BYPASS_TOKEN   the Replit project-protection bypass JWT (replit target only)

param(
    [Parameter(Position = 0)]
    [ValidateSet('local', 'replit', 'show')]
    [string]$Target = 'show',

    # Which .env key holds your local registry token. Each user has their own.
    [string]$TokenVar = 'MCP_TOKEN_JEREMY',

    # Which .env key holds the token for Replit. Same registry, so normally the
    # same variable — override it to fall back to single-token mode.
    [string]$ReplitTokenVar = 'MCP_TOKEN_JEREMY'
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

# `claude mcp add -s local` only writes the project key matching whatever casing
# the CLI resolves right now. ~/.claude.json can hold the SAME repo under multiple
# casing variants of the path (e.g. C:/... and c:/...) as separate project keys —
# different Claude Code entry points (terminal vs. VS Code) resolve different casings.
# After `claude mcp add` runs, copy the entry it wrote onto every other casing variant
# of this repo's project key so no session is left bound to a stale target.
function Sync-ProjectKeyCasing([string]$ProjectRoot, [string]$ServerName, [string]$ExpectedUrl) {
    $claudeJsonPath = Join-Path $HOME '.claude.json'
    if (-not (Test-Path $claudeJsonPath)) {
        Write-Warning "$claudeJsonPath not found; skipping casing sync."
        return
    }

    $data = Get-Content $claudeJsonPath -Raw | ConvertFrom-Json -AsHashtable
    if (-not $data.ContainsKey('projects')) { return }

    $normalizedRoot = $ProjectRoot -replace '\\', '/'
    $matchingKeys = @($data.projects.Keys | Where-Object { ($_ -replace '\\', '/') -ieq $normalizedRoot })
    if ($matchingKeys.Count -le 1) { return }

    # Pick the key whose entry has the URL we just wrote — NOT just "any key with an
    # entry". When every casing variant already has a (possibly stale) entry, picking
    # the first one found is a coin flip that can propagate the stale value outward.
    $sourceKey = $matchingKeys | Where-Object {
        $data.projects[$_].mcpServers -and
        $data.projects[$_].mcpServers.ContainsKey($ServerName) -and
        $data.projects[$_].mcpServers[$ServerName].url -eq $ExpectedUrl
    } | Select-Object -First 1

    if (-not $sourceKey) {
        Write-Warning "Could not find the just-written $ServerName entry to propagate across casing variants."
        return
    }

    $entry = $data.projects[$sourceKey].mcpServers[$ServerName]
    $changed = $false

    foreach ($key in $matchingKeys) {
        # -ceq (case-sensitive), not -eq: PowerShell's -eq on strings is case-insensitive
        # by default, so a plain -eq here treats "c:/..." and "C:/..." as the same key
        # and silently skips every variant — exactly the casings this function exists
        # to tell apart.
        if ($key -ceq $sourceKey) { continue }
        if (-not $data.projects[$key].mcpServers) {
            $data.projects[$key]['mcpServers'] = @{}
        }
        $existing = $data.projects[$key].mcpServers[$ServerName]
        if ($existing -and $existing.url -eq $entry.url) { continue }
        $data.projects[$key].mcpServers[$ServerName] = $entry
        $changed = $true
    }

    if ($changed) {
        ($data | ConvertTo-Json -Depth 100) | Set-Content -Path $claudeJsonPath -Encoding utf8NoBOM
        Write-Host "Synced '$ServerName' across $($matchingKeys.Count) casing variants of the project key." -ForegroundColor Cyan
    }
}

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

Sync-ProjectKeyCasing -ProjectRoot $root -ServerName 'joomla-suite' -ExpectedUrl $url

Write-Host ""
Write-Host "joomla-suite now points at the $Target stack (auth: $tokenVarForTarget)." -ForegroundColor Green
if ($Target -eq 'local') {
    Write-Host "  $url"
} else {
    Write-Host "  https://shannon-mcp.replit.app/mcp?project-protection-bypass=<redacted>"
}
Write-Host ""
Write-Host "Restart Claude Code so the session picks up the new URL." -ForegroundColor Yellow
