# ADR-0030 — A cancel is a fence

- **Status:** Accepted (#909)
- **Issue:** #909 (after #360, #500, #505, #901)

## Context

A tree's cancel request (#360) reached its holder only at the holder's next lease renewal (every
10 s): the holder read the request after a confirmed renewal, and an instance taking the lease read
it at the take. A local `app.cancel` only aborted the run in this process. In that window a live
holder could still commit a fenced effect or record and send an outbound call — fenced writes
checked the lease token and the scope's mark, never the cancel — so "cancelled means no money
moves" held only after the window. The tree then undid what it could (`compensateWith`), but a
charge that had already left was a refund, not a prevention.

## Decision

- **The cancel is a durable mark on the fencing backend.** `ExecutionLeaseRepository.requestCancel(tree)`
  writes a row keyed by the tree's `(tenantId, rootExecutionId)` — never by a child's lease, and
  possible before the tree's first `acquire` — beside the leases, in the database the fencing stores
  already share with the lease store (A2). It is idempotent, changes no lease (the holder keeps it,
  renews it and runs the tree's undo under it), and is kept until the fencing stores' retention
  prunes it — only once its tree is over (its lease retired) and the mark is older than the cutoff, never by age alone.
- **Every fencing store reads it in the transaction that checks the lease**, after the lease and the
  scope's mark and — for an effect — after the key's lookup: a stored result replays; a new effect, a
  new intent (`saveIfAbsent`) or a new attempt (`markPending`) is refused with
  `ExecutionCancelFencedError` (`execution.cancelled.fenced`, an `ExecutionCancelledError`),
  nothing written or sent. What ends or reads an attempt claimed before — `markCompleted`,
  `markFailed`, `findByKey` — is accepted. A stale token is still `ExecutionFencedError`, a
  hand-over, before any cancel is looked at.
- **An undo is never refused.** `effectKeyOf` sets `isCompensation` on the keys of a step that
  compensates another (keys are issued, so it cannot be forged), and `rootExecutionId` on every key,
  so a child's key — whose lease is its own — is fenced by its root's cancel.
- **Atomic per backend.** In memory: the synchronous check, repeated at the commit after an
  asynchronous work. SQLite: one `BEGIN IMMEDIATE` for the check and for `requestCancel`. PostgreSQL:
  a pair of advisory locks (namespace 909) — the cancel takes the exclusive one, a fencing
  transaction the shared one before it reads the mark — so a cancel waits for the tree's open fencing
  transactions and one that starts later reads the committed mark; no row to lock, so it does not
  depend on a lease row existing. MongoDB: reads in a transaction take no locks, so the check is a
  write to a per-tree document; a cancel racing it conflicts and the driver runs the transaction
  again.
- **Every path that cancels a tree writes the mark first** — a local `app.cancel` (it resolves only
  once the mark is durable and may reject on a store error, nothing aborted), a remote one, a paused
  tree's, an A2A `CancelTask` — then the tree key the holder's watch reads.
- **A step refused by the cancel stops at once**, not at the next renewal: the holder aborts its own
  pass as for a found cancel, the open undos run under its lease, the record is failed as cancelled.
  Redis keeps no fencing stores (A2): its `requestCancel` writes nothing.

## Consequences

- "No effect after a durable cancel" holds with no window, on every instance (P7). The exceptions
  are named: a result stored before, the tree's own undo, a write already inside its transaction
  (the cancel then answers after it), and a send already claimed, which may still be answered and
  recorded.
- One more abstract method on the lease contract and a table or collection per backend (PostgreSQL
  migration, MongoDB schema +1); an older instance neither writes nor reads it, so a rolling
  deployment migrates first and rolls out after.
- On MongoDB, fenced writes of one tree's `AnyInstance` children conflict and retry.
