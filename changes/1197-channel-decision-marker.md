---
section: Fixed
issue: 1197
---

**A channel's decision of a reassigned send stays a decision after a crash** (#1197): the stored
answer carries an optional `byChannel` marker, so the retention repair of a log write a crash lost
writes `decided`, not `replied` (#1193 did so for the write that did not crash). The field is
additive and optional; a store keeps the answer as written. No migration.
