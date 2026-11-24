---
section: Breaking
issue: 1321
---

**The sweeps of the audit log, the kept executions and the mesh requests are `deleteExpired(cutoff): Promise<number>`** (#1321b, #1343d): `ExecutionAuditLogRepository.deleteByOccurredAtBefore`, `ExecutionHistoryRepository.deleteByEndedAtBefore` and `MeshRequestRepository.deleteByCreatedAtBefore` give the number of rows they removed, and the recovery sweep tells what each look removed (`removeExpired` returns it). `ExecutionTreeRepository.findById` and `saveIfAbsent` (they read the tree from the running execution) are removed: every call names its tree (`findByIdInTree`, `saveIfAbsentInTree`). `TurnStep.content` is `string`.
