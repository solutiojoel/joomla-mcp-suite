# PostToolUse hook: auto-rebuild joomla-mcp when TypeScript source files are edited.
# Receives Claude Code tool event JSON via stdin.
# Outputs JSON so results are visible in the Claude Code conversation.
$raw = [Console]::In.ReadToEnd()
try { $json = $raw | ConvertFrom-Json } catch { exit 0 }
$filePath = $json.tool_input.file_path

if ($filePath -notmatch 'apps[/\\]joomla-mcp[/\\]src') { exit 0 }

Push-Location "c:\Users\Jeremy\code-projects\joomla-mcp-suite\apps\joomla-mcp"
$buildOutput = npm run build 2>&1 | Out-String
$exitCode = $LASTEXITCODE
Pop-Location

if ($exitCode -eq 0) {
    $msg = "joomla-mcp build succeeded. Restart the joomla-mcp server window (port 9300), then I will call reload_tools."
    Write-Output (@{
        hookSpecificOutput = @{
            hookEventName   = "PostToolUse"
            additionalContext = $msg
        }
    } | ConvertTo-Json -Compress)
} else {
    # Non-zero exit surfaces the output as an error in the UI
    Write-Host $buildOutput
    exit 1
}
