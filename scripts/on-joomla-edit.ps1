# PostToolUse hook: auto-rebuild joomla-mcp when TypeScript source files are edited.
# Receives Claude Code tool event JSON via stdin.
$raw = [Console]::In.ReadToEnd()
try { $json = $raw | ConvertFrom-Json } catch { exit 0 }
$filePath = $json.tool_input.file_path

if ($filePath -match 'apps[/\\]joomla-mcp[/\\]src') {
    Write-Host "joomla-mcp source changed — building..."
    Push-Location "c:\Users\Jeremy\code-projects\joomla-mcp-suite\apps\joomla-mcp"
    npm run build 2>&1
    $exitCode = $LASTEXITCODE
    Pop-Location
    if ($exitCode -eq 0) {
        Write-Host "Build succeeded. Restart the joomla-mcp server window (port 9300), then call reload_tools."
    } else {
        Write-Host "Build FAILED — fix TypeScript errors before restarting."
        exit 1
    }
}
