# ADR-0032 — Every store call is bounded

- **Status:** Accepted (#928)
- **Issue:** #928 (after #923, #720, #909; followed by #1017)

## Context

A store that accepts a connection and never answers held a step, its promise and — on PostgreSQL —
a connection with the lease row locked for ever: the lease expired locally and fencing held, but
the call, its resources and a hung `release()` stayed, and one hung renewal stopped every later
one. #923 bounded only `app.close()`.

## Decision

- **A Proxy at the container** bounds every call of every infrastructure contract but the clock, the
  ids and the logger, on the application's `Clock`; the store's own `this` is the real instance.
- **Three bounds, decided when the call starts.** Under a held lease: the trust left, fixed, or the
  lease's loss. Anywhere else: 15 s (half the lease). Retention deletes and A2A file bodies: 5 min.
  The kind comes from the lease scope — a step's frame, or `leaseScope` around the passes' end, a
  tree ended without a pass, a child's run through its completion and a checkpoint write — never
  from a table of methods; `renew` is always unleased, `renewNow`'s and `reclaim` are leased.
- **An unanswered leased call is a hand-over by abandon** (`HeldLease.abandon`): the signal aborts as
  at expiry, nothing is released, the lease expires in the store and the next holder reconciles — the
  fenced effect's row, the pending intent, the latest checkpoint. A timed-out call is never taken as
  done and never as not done.
- **One error family**: `StoreOutcomeUnknownError`, its `StoreCallTimeoutError`, `source` `Command`,
  `Framework` or (#1017) `Transport`; the core decides on `instanceof`.
- **The store packages time out below the bound** (10 s default) and PostgreSQL ends a session idle
  in a transaction after 10 s, so a frozen holder's lease row is freed before a cancel waits on it.

## Consequences

- P8 and A19 (Guarantees). Recovery after a hung call waits up to the lease.
- A virtual-clock test that sits 15 s past a held call now times the call out: such a test releases first.
- A value given as a test `overrides` entry is not bounded.
