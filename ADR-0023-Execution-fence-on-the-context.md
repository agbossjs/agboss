# ADR-0023 — The execution fence on the context

- **Status:** Accepted (#471)
- **Issue:** #471

## Context

A step runs at least once (#265): an instance frozen past its 30 s lease (a GC pause, `SIGSTOP`, a
VM migration) wakes and goes on with the step it was in, while the instance that took the tree over
runs the same step again. The framework fences only its own checkpoint writes (#335). A step's
write to another system lands whenever it is sent, so an application that needed ordered or
exactly-once writes read AGBoss's lease table and kept its own token — internal schema,
implementation-specific, and wrong for `ChildPlacement.AnyInstance` children, which hold leases of
their own.

## Decision

- **Everything on `executionContext.fence`** (`ExecutionFence`): the lease the current step runs
  under — `scopeKey`, `tenantId`, `leaseExecutionId`, `token`, `confirmedUntil`, `assertHeld()`,
  `confirmNow()` and `fenced(observedToken)`. No new injectable: a step already has its
  `ExecutionContext`, and the fence is a fact of its frame, read live (a fence kept past its step
  refuses). One I/O method is accepted on the otherwise data-only context: `confirmNow()`, a strict
  renewal before a call that cannot check tokens, which also runs the #360 cancel checks.
- **The token is a number, per lease key**: `leaseEpoch` of `(tenantId, leaseExecutionId)` — 1 for
  its first holder, + 1 with every take. Written into `ExecutionLeaseRepository`'s contract, so a
  distributed store (#469) counts per key, never by its own revision; no `bigint`.
- **The scope is a string with its parts**: each part `encodeURIComponent`-encoded and joined by one
  `:` — no cross-tenant collision, decodable, unchanged for plain and UUID ids, no `\u0000`
  (rejected by PostgreSQL `TEXT`). The root's lease covers the root, its `ParentInstance` children
  and `ThisWorkflow` levels; an `AnyInstance` child fences with its own. Ancestors' fences and frames
  without a held lease refuse with `ExecutionContextUnavailableError`.
- **A refusal is a hand-over error**: `ExecutionFencedError extends ExecutionLeaseLostError`
  (`execution.lease-lost.fenced`, following the rule that a subclass's code extends its parent's),
  found anywhere in a cause chain or an `AggregateError` and checked **before** the signal's reason
  at every place the runtime decides about a failure — the error itself is rethrown, and the holder
  of its token is stopped with it.
- **The remote-children wait yields the lease only while no other step of the tree runs**: a
  sibling `ParentInstance` branch's step used to run and checkpoint with the root's lease released.
- **Testing**: a `leases` fixture (`stall` / `resume` around the lease contract and the instance's
  lease timers) and a held lease in every unit runner (`fence` option).

## Consequences

- Exactly-once becomes possible where the external system checks the token and the idempotency key
  in one transaction; the framework never claims it on its own (documented with a reference SQL).
- A high-water mark must be keyed by `scopeKey`: keyed by a shared aggregate it refuses healthy
  `AnyInstance` children with independent epochs.
- A step whose lease's own expiry fires before its fenced write settles still ends its call with
  `ExecutionLeaseLostError` (LangGraph rejects the pass on the abort before the step's body
  returns); the write is refused either way.
- A withdrawal made after the tree ended runs without a fence (its frame is rebuilt from the
  checkpoint); a withdrawal made inside a pass has its step's.
