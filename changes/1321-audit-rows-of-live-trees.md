---
section: Breaking
issue: 1321
---

**The audit log's rows are removed only for trees that have ended** (#1321b): a takeover reads the hand-over rows of its tree to charge the passes the previous holder lost (#853), so the sweep never removes a row of a tree that is live or paused, whatever `auditLogTtl` says. `ExecutionAuditLogRepository.deleteExpired(cutoff, isEnded)` takes the check of an ended tree and removes the rows older than `cutoff` of the trees it answers `true` for; `Ttl.None` removes a tree's rows at the first sweep after the tree ends. Audit rows are always written.
