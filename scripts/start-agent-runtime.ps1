# Start the agent-runtime (Solutio AI Dashboard backend, port 18310) in a new
# terminal window. Requires the orchestrator (9302) for catalog tools/prompts;
# degrades gracefully if it's down.
# Run from anywhere -- the script resolves paths relative to itself.

$root = Split-Path -Parent $PSScriptRoot
$port = 18310

$pArgs = @("-NoExit", "-Command", "& { `$host.UI.RawUI.WindowTitle = 'agent-runtime :$port'; Set-Location '$root\apps\agent-runtime'; `$env:AGENT_RUNTIME_PORT='$port'; node dist/index.js }")
Start-Process powershell -ArgumentList $pArgs

Write-Host "Started agent-runtime on port $port."
Write-Host "Dashboard API base: http://localhost:$port/api  (health: /healthz)"
