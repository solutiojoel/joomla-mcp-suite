# Agent Process Improvement Log

A shared queue of workflow improvements, efficiency gains, KB gaps, and tool behaviors discovered by agents during live sessions. Not site-specific — everything goes here regardless of which site triggered it.

Reviewed periodically by the team and implemented into workflow guides, KB articles, tooling, or CLAUDE.md as appropriate.

---

## How to Contribute

At the end of any session, mentally replay the steps taken. If any of the following apply, append an entry below:

- A task required more attempts or steps than it should have
- A workaround was needed because a tool, KB article, or workflow step was missing
- A KB article was incomplete, wrong, or didn't cover the actual case encountered
- A better approach was discovered mid-task that would save time next time
- A tool behaved unexpectedly — in a useful or problematic way
- A pattern repeated across multiple sites that warrants documentation
- A step in a workflow guide turned out to be in the wrong order or missing a prerequisite
- Something caused the agent to go down a wrong path before course-correcting

Keep entries concise. This is a review queue, not a journal. One tight paragraph per entry is enough.

**Only add an entry if something genuinely useful was found.** Not every session needs one — this is not a mandatory per-session log like the site changelog.

---

## Entry Format

```
### YYYY-MM-DD — [Category] | [Short title]
**Context:** [What task triggered this — ticket #, site, type of work]
**Observation:** [What was found or what went wrong]
**Suggested fix:** [New KB article / workflow step change / tool request / wording tweak]
**Status:** pending
```

**Categories:**

| Category | Use when |
|----------|---------|
| `KB Gap` | A KB article was missing, incomplete, or didn't cover the real case |
| `Workflow` | A step in a workflow guide was wrong, missing, or in the wrong order |
| `Efficiency` | A better sequence of steps was found that saves time |
| `Tool Behavior` | A tool behaved unexpectedly — either a limitation or a useful undocumented behavior |
| `Bug/Quirk` | A Joomla or Gantry behavior that trips agents up and should be warned about |
| `Tooling Request` | A missing tool that would meaningfully reduce steps or risk |

---

## ⏳ Pending Review

*(No entries yet — first entries will appear here after sessions where improvements are found)*

---

## ✅ Implemented

*(Entries are moved here after being acted on, with a note on what was changed)*
