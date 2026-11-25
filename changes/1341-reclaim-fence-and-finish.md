---
section: Breaking
issue: 1341
---

**A reclaim under an `Immediate` pause inherits the fence; a finish is conditional on no stop or cancel mark**
(#1341, money review 2026-11-25, findings 1 and 5).

`ExecutionLeaseRepository.reclaim` (#516: a holder takes back the lease it yielded while it waited for
remote children) now writes `fencedThroughToken = GREATEST(itself, token + 1)` **in the same atomic step**
while an `Immediate` external pause is set on the tree's row. Before, the reclaimed token was above the fence,
so after an `app.pause(…, { mode: Immediate })` from another instance the root's `runOnce` on it and every
child's write (checked against the root's row) committed for up to one renewal. Now the holder's first write
is refused with `ExecutionPauseFencedError` and the holder parks. `acquire` is unchanged (the unpause take and
a cancel's unwind take `token + 1` unfenced), and so is a reclaim under an `AfterStep` pause or after
`unpause`. A cancel or stop mark already fenced by the row, whatever the token. The cluster path mirrors it:
`ClusterLeaseMirror.syncClusterLease(lease, take?)` takes `ClusterLeaseTake` (`{ isReclaim }`, new in
`@agboss/core/stores`), and a reclaim's mirror raises the fence in its own upsert.

`ExecutionRecordRepository.completeUnlessInterrupted(turnId, outcome, context?)` (new, abstract) completes a
record only while its tree (`tenantId`, `runId`) carries no stop or cancel mark on its lease row, read in the
write's own transaction. The finish uses it, so a remote `app.cancel` that lands between the finish's look and
its write makes the run end cancelled, as the cancel answered, never `answered`. The in-memory records read the
in-memory lease rows in the same synchronous step, and the SQLite records read the file's `execution_leases`
inside the write's `BEGIN IMMEDIATE`. A `TurnStoreRecordRepository` takes the marks as its second argument
(`isInterrupted`), and none given means no mark is seen.

Store follow-up (T-train):

- postgres, mongodb, redis `reclaim`: while `is_externally_paused` and `external_pause_mode = 'immediate'`,
  the reclaim's one statement (MongoDB: its update pipeline; Redis: its script) also sets
  `fenced_through_token` to `GREATEST(COALESCE(fenced_through_token, 0), lease_epoch + 1)`.
- postgres, mongodb `syncClusterLease(lease, { isReclaim: true })`: the same in the upsert, with the mirrored
  token.
- postgres, mongodb `ExecutionRecordRepository.completeUnlessInterrupted`: a conditional `UPDATE`, refused while
  the row of `execution_leases` for the record's `tenant_id` and `run_id` has `cancel_requested_at` or
  `stop_mode` set, with the history row in the same transaction (MongoDB: the lease row read inside the
  write's transaction).
- New contract cases: `execution-lease-pause.cases.ts`, `fenced-effect-pause.cases.ts`,
  `execution-lease-cluster.contract.ts`, `execution-record-status-history.cases.ts`.
