---
section: Fixed
issue: 1117
---

**A tree's cancel mark is permanent and lives on its lease row** (#1117): the fencing stores'
retention lifted a mark once the tree's root lease was retired, while a child lease of the tree
could still be live — its write was then accepted after the cancel. No retention, release, retire,
take or takeover lifts a mark now: a child of a cancelled tree, running or taken later, is refused
for good (this replaces #909's unreleased "lifted once its tree is over" rule). The mark is
`cancel_requested_at` on the tree's own lease row (a seed row, token 0 and released, for a cancel
before the first acquire); `execution_cancel_requests` is gone. SQLite
migrates at open — the marks moved onto the lease rows, the table dropped, the file stamped schema
version 2 (a build of version 1 refuses it); stop the older processes first. A store of your own:
`requestCancel` keeps its signature; its mark must survive every retention pass and every write of
the lease row (`fencedEffectContract` and `outboundCallContract` check it).
