# Site Notes: solutio-sop.solutiosoftware.com

Notes logged by AI agents.

### 2026-06-18 — MCP Server Setup page created
**Requested by:** jeremy@solutiosoftware.com | **Ticket:** none
**Changes:**
- Created article ID 246 "MCP Server Setup — Personal Configurations" in category 61 (Specialty Items), access level 3 (Registered)
- Created menu item ID 270 "MCP Server Setup" in mainmenu under parent 148 (Specialty Items), access level 3 (Registered), links to article 246
- Article contains per-person accordion (HTML details/summary) with individual ORCHESTRATOR_TOKEN bearer tokens for: Albert (al), Tori, Joel, Adam, Dakota, Jackie
- All config.toml entries use [SERVER-IP] placeholder — replace via article update when IP is confirmed
**Notes:** Access control is Registered (login required). Joomla natively redirects unauthenticated users to /index.php?option=com_users&view=login — no login module needed. Joel's developer_instructions differ from the other five (broader agent scope vs. support-only). No Gantry tools used per instruction.
_Logged by: local_

### 2026-06-19 — MCP Server Setup article — restored missing features + moved scripts to module
**Requested by:** jeremy@solutiosoftware.com | **Ticket:** none
**Changes:**
- Article 246: restored copy buttons (12 total, one per panel), added onclick handlers to Codex/Claude Code tab buttons, removed inline &lt;script&gt; block
- Created module ID 150 "MCP Server Setup — Scripts" (mod_rawtags, content-bottom-a, assigned to menu item 270 only) containing: @keyframes mcp-glint-anim CSS + all JS (mcpShowTab, mcpCopy, details accordion with glint animation)
**Notes:** Glint animation flashes panel background to #dce8ff on open (0.9s). Script runs after article content so querySelectorAll('details') finds all panels without DOMContentLoaded wrapper.
_Logged by: local_
