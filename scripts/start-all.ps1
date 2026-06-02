# Start all three MCP services in separate terminal windows.
# Run from anywhere -- the script resolves paths relative to itself.
#
# Ports:
#   joomla-mcp   -> 9300
#   gantry-mcp   -> 9301
#   orchestrator -> 9302  (what Claude Desktop connects to)

$root = Split-Path -Parent $PSScriptRoot

$joomlaPort = 9300
$gantryPort = 9301
$orchPort   = 9302

function Start-McpService([string]$Title, [string]$Dir, [string]$Cmd) {
    $pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = '$Title'; Set-Location '$Dir'; $Cmd }")
    Start-Process powershell -ArgumentList $pArgs
}

Write-Host "Starting joomla-mcp on port $joomlaPort..."
Start-McpService "joomla-mcp :$joomlaPort" "$root\apps\joomla-mcp" "`$env:HTTP_PORT='$joomlaPort'; node dist/index.js"

Write-Host "Starting gantry-mcp on port $gantryPort..."
Start-McpService "gantry-mcp :$gantryPort" "$root\apps\gantry-mcp" "`$env:HTTP_PORT='$gantryPort'; node mcp-server.js"

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

Write-Host "Waiting for joomla-mcp..." -NoNewline
if (Wait-Port $joomlaPort) { Write-Host " ready." } else { Write-Error "joomla-mcp did not start in time."; exit 1 }

Write-Host "Waiting for gantry-mcp..." -NoNewline
if (Wait-Port $gantryPort) { Write-Host " ready." } else { Write-Error "gantry-mcp did not start in time."; exit 1 }

Write-Host "Starting orchestrator on port $orchPort..."
Start-McpService "orchestrator :$orchPort" "$root\apps\joomla-orchestrator" "`$env:HTTP_PORT='$orchPort'; node orchestrator.js"

Write-Host ""
Write-Host "All services running."
Write-Host "  Orchestrator: http://localhost:$orchPort/mcp"
Write-Host ""
Write-Host "Claude Desktop connects via mcp-remote -- no changes needed after first setup."
Write-Host "Close the three terminal windows to stop all services."
