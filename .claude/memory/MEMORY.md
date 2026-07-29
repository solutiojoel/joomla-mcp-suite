# Memory Index

- [Project Structure](project-structure.md) — monorepo layout, orchestrator as single MCP entry point, how agent files work
- [User Profile](user-profile.md) — Jeremy at Solutio Software, Joomla/Gantry 5 agency platform
- [Reload After Build](feedback-reload-after-build.md) — call reload_tools after any joomla-mcp build or server restart
- [Orchestrator stdio vs HTTP](orchestrator-stdio-vs-http.md) — Claude Code runs its own stdio orchestrator from .mcp.json; restarting port 9302 doesn't refresh in-session tools
- [New User Password Reset](feedback-new-user-password-reset.md) — always set requireReset=1 when creating new Joomla user accounts
- [Username Convention](feedback-username-convention.md) — Joomla usernames must be the full email address, not a short handle
- [Fresh Menus for Builds](feedback-fresh-menus.md) — Phase 4 always creates new client-named menus; never use or alter existing forge menus
- [Joomla Version](joomla-version.md) — all sites run Joomla 3; no J4/J5 in use; Isis admin template, standard selects, J3 MenusController
- [Sub-Agent Architecture](sub-agent-architecture.md) — planned agents-mcp downstream for LLM-backed tool handlers; direct leaf connections, no second orchestrator, timeout/site-injection risks
