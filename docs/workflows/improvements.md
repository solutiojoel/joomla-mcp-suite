# Process Improvement Log

Shared queue for workflow improvements discovered during real builds. Reviewed periodically to update workflow docs and KB articles.

---

## Format

```
### YYYY-MM-DD — [Short title]
**Agent:** [menu-build | support | super_shannon]
**What happened:** [What went wrong or took extra steps]
**Root cause:** [Why it happened]
**Fix applied:** [What was changed — doc, KB, code, schema]
**Status:** [Fixed | Pending | Won't fix]
```

---

## Entries

### 2026-06-16 — Menu builds should always create fresh menus, never alter existing

**Agent:** menu-build  
**What happened:** Pre-Phase 4 confirmation identified `tempsite-menu` as the target for the SHE build. That would have altered a shared/existing forge menu rather than building clean. User corrected this mid-session.  
**Root cause:** The workflow doc said to map `mainmenu` to the "site-specific menu" found on the forge site. On a forge site the only options were shared template menus (`mainmenu`, `tempsite-menu`) — none were safe to use for a client build.  
**Fix applied:** Updated Pre-Phase 4 step 1 in `menu-build-workflow.md` to always create fresh client-named menus (e.g. "School Menu" / "School Hidden Menu") and never alter existing forge menus. Also added `joomla_ids` block to the spec format to record created menu and category IDs.  
**Status:** Fixed
