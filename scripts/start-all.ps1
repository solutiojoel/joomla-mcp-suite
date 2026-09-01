# Start the local MCP stack, each service in its own terminal window.
# Run from anywhere -- the script resolves paths relative to itself.
#
# Every service is defined once, in its own start-<name>.ps1. This script calls
# those scripts, waits for each port, then starts the orchestrator last.
#
# Core stack (always started):
#   joomla-mcp            -> 9300
#   gantry-mcp            -> 9301
#   freshdesk-mcp         -> 9303
#   ftp-mcp               -> 9304
#   knowledge-gateway-mcp -> 9306
#   agents-mcp            -> 3506
#   orchestrator          -> 9302  (what Claude Desktop and mcp-target.ps1 connect to)
#
# Optional services (opt in with a switch):
#   -WithDashboard     sub-agent run dashboard -> 3507
#   -WithAgentRuntime  agent-runtime -> 18310
#   -All               all three of the above
#
#   -Restart           stop whatever already holds each port, then start clean
#
# A port that is already in use is the failure this script exists to catch.
# Waiting for the port is not enough on its own: if an earlier process still
# holds it, the new window dies with EADDRINUSE while the port stays open, so
# the wait succeeds and the stack silently keeps running the OLD code. That is
# how a rebuilt server gets tested against a stale process. Every port is now
# settled before anything starts: occupied ports are named with their owning pid
# and skipped, or freed first with -Restart.

param(
    [switch]$WithDashboard,
    [switch]$WithAgentRuntime,
    [switch]$All,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

if ($All) {
    $WithDashboard    = $true
    $WithAgentRuntime = $true
}

# Name = the start-<Name>.ps1 script to call; Port = the port to wait for.
$core = @(
    @{ Name = 'joomla-mcp';            Port = 9300 },
    @{ Name = 'gantry-mcp';            Port = 9301 },
    @{ Name = 'freshdesk-mcp';         Port = 9303 },
    @{ Name = 'ftp-mcp';               Port = 9304 },
    @{ Name = 'knowledge-gateway-mcp'; Port = 9306 },
    @{ Name = 'agents-mcp';            Port = 3506 }
)

$optional = @()
if ($WithDashboard)    { $optional += @{ Name = 'dashboard';     Port = 3507 } }
if ($WithAgentRuntime) { $optional += @{ Name = 'agent-runtime'; Port = 18310 } }

function Start-McpService([string]$Name) {
    $script = Join-Path $PSScriptRoot "start-$Name.ps1"
    if (-not (Test-Path $script)) {
        Write-Error "Missing start script: $script"
        exit 1
    }
    & $script
}

function Wait-Port([int]$Port, [int]$TimeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $tcp = [System.Net.Sockets.TcpClient]::new()
            $tcp.Connect("127.0.0.1", $Port)
            $tcp.Close()
            return $true
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

# The process listening on a port, or $null. Identity matters here, not just
# reachability: "the port answers" and "the service I just started answers" are
# different facts, and only the second one means the stack runs current code.
function Get-PortOwner([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    return [pscustomobject]@{
        Pid     = $conn.OwningProcess
        Name    = $proc.Name
        Started = $proc.CreationDate
    }
}

# Free a port so the service can claim it. Returns $true once nothing listens.
function Stop-PortOwner([int]$Port, [int]$TimeoutSec = 15) {
    $owner = Get-PortOwner $Port
    if (-not $owner) { return $true }
    Write-Host "  stopping pid $($owner.Pid) ($($owner.Name), started $($owner.Started))"
    Stop-Process -Id $owner.Pid -Force -Confirm:$false -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-PortOwner $Port)) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

$services = $core + $optional

# Services left running on a process this script did not start. They are the
# whole point of the check: the stack looks healthy while serving old code.
$stale = @()

# Settle every port BEFORE starting anything, so the services below still start
# in parallel. Checking afterwards cannot tell "my new window bound" from "the
# old process never let go" — both leave the port answering, which is exactly
# how a stale service passes for a fresh one.
foreach ($svc in $services + @(@{ Name = 'orchestrator'; Port = 9302 })) {
    $owner = Get-PortOwner $svc.Port
    if (-not $owner) { continue }

    if ($Restart) {
        Write-Host "$($svc.Name): port $($svc.Port) in use." -ForegroundColor Yellow
        if (-not (Stop-PortOwner $svc.Port)) {
            Write-Error "$($svc.Name): could not free port $($svc.Port)."
            exit 1
        }
    } else {
        Write-Warning ("{0}: port {1} is already held by pid {2} ({3}, started {4})." -f `
            $svc.Name, $svc.Port, $owner.Pid, $owner.Name, $owner.Started)
        Write-Warning "  Not started. That process keeps serving whatever code it loaded at start time."
        $stale += $svc.Name
    }
}

foreach ($svc in $services) {
    if ($stale -contains $svc.Name) { continue }
    Start-McpService $svc.Name
}

# The orchestrator opens a fresh connection per call, so it can start before a
# downstream is ready. Waiting first still gives a clear failure on a dead service.
foreach ($svc in $services) {
    Write-Host "Waiting for $($svc.Name) on $($svc.Port)..." -NoNewline
    if (Wait-Port $svc.Port) {
        Write-Host " ready."
    } else {
        Write-Error "$($svc.Name) did not start in time."
        exit 1
    }
}

if ($stale -notcontains 'orchestrator') {
    Start-McpService 'orchestrator'
    if (-not (Wait-Port 9302)) {
        Write-Error "orchestrator did not start in time on port 9302."
        exit 1
    }
}

Write-Host ""
if ($stale.Count -eq 0) {
    Write-Host "All services running." -ForegroundColor Green
} else {
    $total = $services.Count + 1   # + orchestrator
    if ($stale.Count -ge $total) {
        Write-Host "Nothing started. Every port was already in use:" -ForegroundColor Yellow
    } else {
        Write-Host "Started $($total - $stale.Count) of $total. Already in use:" -ForegroundColor Yellow
    }
    foreach ($name in $stale) { Write-Host "  - $name" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "Those processes serve the code they loaded at start time, not the working tree." -ForegroundColor Yellow
    Write-Host "Re-run with -Restart to stop them and start clean." -ForegroundColor Yellow
}
Write-Host "  Orchestrator: http://localhost:9302/mcp"
Write-Host ""
Write-Host "Point Claude Code at it with: .\scripts\mcp-target.ps1 local"
Write-Host "Close the terminal windows to stop all services."
