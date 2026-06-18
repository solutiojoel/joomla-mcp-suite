---
name: feedback-username-convention
description: "Joomla usernames must always be the full email address, not a short handle"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 96bfe259-1aac-4bce-852a-7efbe294506f
---

Always set new Joomla user account usernames to the user's full email address (e.g., `lkuchinskas@magdalenwichita.com`), not a short handle (e.g., `lkuchinskas`).

**Why:** Discovered after creating 4 teacher accounts with short usernames — Jeremy corrected all of them.

**How to apply:** Pass the email value as the `username` parameter in every `joomla_user` create call.
