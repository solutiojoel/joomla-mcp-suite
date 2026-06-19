# Site Notes: sop.solutiosoftware.com

Notes logged by AI agents.

### 2026-06-18 — Redesign MCP Instructions page with tabs and copy-all blocks
**Requested by:** Jeremy | **Ticket:** none
**Changes:**
- Updated article ID 246 ("MCP Server Setup — Personal Configurations")
- Replaced individual step-by-step code blocks with single copyable textarea per person (Copy All button + clipboard API)
- Added Codex / Claude Code tab toggle (JS tabs, no external dependencies)
- Claude Code tab uses ~/.claude.json mcpServers entry with Bearer ${ORCHESTRATOR_TOKEN} header + ~/.claude/CLAUDE.md developer instructions
- Codex tab preserves existing config.toml + prompts/support.md approach
- Joel's entries have super-agent developer_instructions; all others have support-agent instructions
**Notes:** Page is access=3 (Registered only). Script tags saved via API — verify JS tabs work on first login.
_Logged by: local_
