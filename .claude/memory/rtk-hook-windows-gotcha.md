---
name: rtk-hook-windows-gotcha
description: "Why rtk shows \"No hook installed\" + \"rg not found\" on Windows and how to fix it"
metadata: 
  node_type: memory
  type: reference
  originSessionId: ba09b1a9-0f04-4bbe-976d-047598668657
---

Two separate rtk issues seen together on Jeremy's Windows machine:

1. **"No hook installed — run `rtk init -g`"** is a *false positive*. rtk's detector scans `~/.claude/settings.json` PreToolUse hook commands for the literal token `rtk hook claude`. A PowerShell wrapper command (e.g. `powershell.exe ... -File rtk-claude-hook.ps1`) executes fine but does NOT contain that token, so rtk warns every time it processes/proxies a command. The warning is throttled via mtime of `C:\Users\Jeremy\AppData\Roaming\rtk\.hook_warn_last` (so it feels intermittent). **Fix:** set the hook `command` to the canonical `rtk hook claude` for both the Bash and PowerShell matchers. Works because `C:\Users\Jeremy\.local\bin` (rtk.exe) is on the Windows User PATH, so no wrapper is needed.

2. **"Binary 'rg' not found on PATH"** — ripgrep wasn't installed. Fixed with `winget install BurntSushi.ripgrep.MSVC` (adds it to User PATH). rtk falls back to direct exec without it, so it's a warning not a failure.

After changing settings.json hooks OR installing something that edits PATH, **the running Claude Code / VS Code must be restarted** — an already-running session has a stale PATH and stale loaded hook config. Detection (`rtk hook claude`) reads settings.json fresh, but live proxying + PATH are fixed at launch.

The unused wrapper script `C:\Users\Jeremy\.claude\hooks\rtk-claude-hook.ps1` is left in place as a harmless fallback. Editing settings.json to add a `-ExecutionPolicy Bypass` PowerShell hook is blocked by the auto-mode classifier (self-modification + security-weaken) — use the bare `rtk hook claude` form instead.
