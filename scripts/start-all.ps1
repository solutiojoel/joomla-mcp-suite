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
#   -WithMockup        mockup-analyzer -> 9305   (needs Python)
#   -WithDashboard     sub-agent run dashboard -> 3507
#   -WithAgentRuntime  agent-runtime -> 18310
#   -All               all three of the above

param(
    [switch]$WithMockup,
    [switch]$WithDashboard,
    [switch]$WithAgentRuntime,
    [switch]$All
)

$ErrorActionPreference = 'Stop'

if ($All) {
    $WithMockup       = $true
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
if ($WithMockup)       { $optional += @{ Name = 'mockup-mcp';    Port = 9305 } }
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

$services = $core + $optional

foreach ($svc in $services) {
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

Start-McpService 'orchestrator'

Write-Host ""
Write-Host "All services running." -ForegroundColor Green
Write-Host "  Orchestrator: http://localhost:9302/mcp"
Write-Host ""
Write-Host "Point Claude Code at it with: .\scripts\mcp-target.ps1 local"
Write-Host "Close the terminal windows to stop all services."
