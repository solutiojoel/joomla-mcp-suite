# Switch the `joomla-suite` MCP registration between the local stack and Replit.
#
#   .\scripts\mcp-target.ps1 local     -> http://127.0.0.1:9302/mcp   (start-all.ps1 must be running)
#   .\scripts\mcp-target.ps1 replit    -> https://shannon-mcp.replit.app/mcp
#   .\scripts\mcp-target.ps1 show      -> print the current registration
#
# Local hosting exists to dodge the Joomla host's throttling of cloud egress IPs.
# See .agents/memory/joomla-host-throttling.md. Restart Claude Code after switching —
# an in-session MCP connection does not re-resolve its URL.

param(
    [Parameter(Position = 0)]
    [ValidateSet('local', 'replit', 'show')]
    [string]$Target = 'show'
)

$ErrorActionPreference = 'Stop'

$token       = 'RgOPSb46DHV8/GEirOLyMVTf8UzLjRP0jAw3HdrC684='
$localUrl    = 'http://127.0.0.1:9302/mcp'
$replitBypass = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzb3VyY2UiOiJ1c2VyLW1hbmFnZWQiLCJkZXBsb3ltZW50SWQiOiIwYmYwZmVkMy1lODlmLTQxNjYtYjRhMC1kYjk2M2I2YTZiMjMiLCJqdGkiOiJSS0NjUktaeW1aOU5LcU8tOVRHNU8iLCJpYXQiOjE3ODUxNjY1NTUsImV4cCI6MTk0Mjg0NjU1NX0.-EWAsXm_6R_yG7XeRNT8BL-UK6jSyq_Zr__T3OhnBF7zJw89g_kh6YGgNsZy3lgOsZLfvUYjWRP0NG5wnNhOdg'
$replitUrl   = "https://shannon-mcp.replit.app/mcp?project-protection-bypass=$replitBypass"

if ($Target -eq 'show') {
    claude mcp get joomla-suite
    return
}

$url = if ($Target -eq 'local') { $localUrl } else { $replitUrl }

if ($Target -eq 'local') {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    try {
        $tcp.Connect('127.0.0.1', 9302)
        $tcp.Close()
    } catch {
        Write-Warning "Nothing is listening on 127.0.0.1:9302. Run .\scripts\start-all.ps1 first."
    }
}

try { claude mcp remove joomla-suite -s local | Out-Null } catch { }
claude mcp add --transport http joomla-suite $url --header "Authorization: Bearer $token"

Write-Host ""
Write-Host "joomla-suite now points at the $Target stack:" -ForegroundColor Green
Write-Host "  $url"
Write-Host ""
Write-Host "Restart Claude Code so the session picks up the new URL." -ForegroundColor Yellow
