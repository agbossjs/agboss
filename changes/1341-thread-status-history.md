---
section: Breaking
issue: 1341
---

**A thread's status history** (#1341, part d): every change of a thread's status is one row of
`thread_status_transitions` — `ThreadStatusTransition` (`seq`, `fromStatus`, `toStatus`, `trigger`,
`reason`, `actor`, `leaseToken`, `at`) — written in the very transaction of the change: a record's
status write (`append`, `complete`, `completeIfStatus` of `ExecutionRecordRepository`) or a lease
mark (`ExecutionLeaseRepository.requestCancel(tree, transition?)`), so a crash between the change and
its row is impossible. `app.getStatusHistory(threadId, …tenantArgs)` (also on `TestApp`) reads it,
oldest first. `app.cancel(threadId, { reason })` keeps its reason and `ownerId` (as `actor`) in the
history. A repeated command and a write that leaves the status as it was add no row. The history is
removed with its thread (`deleteIdleThreads`) and, for an application that keeps no execution history
(`historyTtl: Ttl.None`), when its tree ends (`forgetTree`).

Removed / changed: `ExecutionRecordRepository` gains the abstract `statusHistory(tenantId, threadId)`
and `forgetStatusHistory(tenantId, threadId)`, and an optional `StatusContext` last argument on
`append`, `complete` and `completeIfStatus`; `ExecutionLeaseRepository.requestCancel` takes an
optional `NewStatusTransition`; `InMemoryExecutionRecordRepository` now has the deps `[Clock,
IdGenerator, IN_MEMORY_DATABASE]` (it shares its history with the in-memory lease store).

Store follow-up (train T3): a table `thread_status_transitions (tenant_id, thread_id, seq, from_status,
to_status, trigger, reason, actor, lease_token, at)` keyed and indexed by `(tenant_id, thread_id, seq)`;
the record store's three writes and the lease store's `requestCancel` write the row in their own
transaction (reading the thread's last row for `from_status` and `seq`, writing none when the status
is unchanged); `statusHistory` / `forgetStatusHistory`; the deletion of a thread's rows with it. New
contract cases: `execution-record-status-history.cases.ts`, and the transition case of
`execution-lease-cancel.cases.ts`.
