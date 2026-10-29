# ADR-0024 — Published store contract suites

- **Status:** Accepted (#481)
- **Issue:** #481 (part of #469)

## Context

Store implementations beyond the built-in in-memory and SQLite ones (PostgreSQL first, Redis later)
are going to live in repositories of their own (#469). The only proof that a store honours its
contract — an atomic lease takeover, fencing epochs, the child queue's claim order, one of two
concurrent pause transitions — were the core's internal suites (`tests/infrastructure/*.contract.test.ts`
over `storeKinds`). A store outside the core could not run them, so it could not show that it
behaves as SQLite does, and the core's own stores and an external one could drift apart.

## Decision

- **The suites are published** as `@agboss/core/testing/contracts`: one function per contract —
  the nine #265 / #333 / #398 / #401 repositories and LangGraph's `BaseCheckpointSaver` — taking a
  `ContractTarget<TStore>` (`name`, `instance(seam)`, `reset?()`, `close?(store)`). An entry of its
  own with its API report; `@agboss/core/testing` does not re-export it, because it imports vitest's
  `describe` / `it` (vitest stays an optional peer).
- **The core runs the same suites**: `tests/infrastructure/*.contract.test.ts` call the published
  functions with two targets (`inMemoryTarget`, `sqliteTarget`); `storeKinds` is gone. What the
  in-memory and SQLite stores pass is exactly what an external store runs.
- **The suite owns the clock** (#265: stores take time from the framework's `Clock`): every case gets
  a new `VirtualClock` at `2026-01-05T09:00:00.000Z`, shared by the case's two instances and moved
  only by the case — a store that reads the database's or the machine's time fails the time-based
  cases.
- **Every case runs on two instances over one backing store**: `reset()`, then `instance()` for
  `instance-1` and `instance-2`, the case, `close()` for each built store; a case needing one
  instance uses the first. A failing `reset()` fails the case with its own error; the case's error
  wins over a failing `close()`.
- **Store rules only**: cases that run a whole application (`testWith`, fixture applications) test
  the framework over a store, not the store, and stay in the core's own tests. The rules keep their
  names, so a failure in a store's repository reads as in the core; every suite ends with `ping()`.
- **Proof that a suite catches a broken store**: the core runs fixture suites against deliberately
  broken stores in a nested vitest (`startVitest`), the only way to assert a failing suite without
  failing its own run.

## Consequences

- One more public entry and API report to keep; the case tables are the contracts' executable
  specification, and a change to one is a change of the published API's behaviour.
- A new store contract gets its published suite with it, or it cannot be implemented outside the core.
- The in-memory stores stay internal: an outside author tests their own implementation (or a
  public SQLite one), never a copy of the core's.
