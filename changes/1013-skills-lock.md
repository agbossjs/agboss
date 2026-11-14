---
section: Fixed
issue: 1013
---

**The skills sync lock holds against a live sync, however slow** (#1013, follow-up of #983): the lock records the owner's pid, host and start time; a lock is stale only when its owner is dead on this host (taken over at once, no 12 s wait), or, for another host or an unreadable owner, after 10 minutes. A waiter never breaks a live lock: after its wait it only reads, and says one honest `[skills.sync-failed]` unless the folder is current. A sync releases only its own lock, two waiters on one stale lock cannot both take it, and Ctrl-C releases it. Also: the project's own symlinks inside `.agents/skills/agboss/` are no longer dropped silently (a link that stays inside the project is kept and never followed, all are named in `[skills.unmanaged-file]`), and an interrupted move that finds one own file with different bytes in both folders saves the old one as `<name>.legacy` instead of losing it. No migration.
