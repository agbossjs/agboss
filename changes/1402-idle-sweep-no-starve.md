---
section: Fixed
issue: 1402
---

**The idle-thread sweep no longer starves, and its audit rows go with it** (#1402): a look took the 100
longest-idle threads of a workflow and skipped the ones with a live or paused run, so 100 paused threads hid every
older-than-ttl thread behind them and the memory `ttl` stopped working. A look now pages past the threads it kept
(a keyset cursor kept per workflow, bounded per look). The audit-log rows of a tree whose record the idle sweep
removed read as live (no record) and stayed for ever; they are now removed with their thread. No migration.
