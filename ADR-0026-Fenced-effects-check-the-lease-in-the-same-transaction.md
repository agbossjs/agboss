# ADR-0026 — Fenced effects check the lease in the same transaction

- **Status:** Accepted (#500)
- **Issue:** #500 (part of #479; PostgreSQL in #482)

## Context

#471 gave every step a fencing token (`executionContext.fence`). An application that writes business
rows still had to build the same thing each time: a high-water-mark table per lease scope, an
idempotency table, and their subtle order — a stale token refused **before** the key is read, so a
zombie never receives the new holder's result. agbossjs/distributed-agent-recovery carried a
`LeaseFencingService` and `fencing_tokens` DDL only for this.

A high-water mark alone has a race: a zombie that wakes **before** the new holder wrote finds the
mark still at its own token and writes. Only the lease itself knows that another instance took it.

## Decision

- **A repository contract, generic over the store's transaction:** `FencedEffectRepository<TTransaction>`
  with `saveResultIfAbsent(key, work)`, the key from `fencedEffectKeyOf(executionContext, name)`. The
  business rows of the write go in the same transaction (`InMemoryFencedEffectTransaction`, SQLite's
  `DatabaseSync`, a PostgreSQL client), so the application keeps no fencing or idempotency table.
- **The lease is checked in the same transaction**, before the mark: the lease row of the key's scope,
  in the same database, must be the key's (its epoch, not released, not expired). A zombie is refused
  even when it reaches the write first. The price: the fenced-effect store and the lease store must be
  of one database — each implementation declares its lease store (`static leaseRepository`), and a
  listed mismatch fails assembly (`[application.fenced-effect-lease-store]`). **Amended by #526:**
  the check is by backend — each store declares `static backend`, a listed fenced-effect or
  outbound-call store and the lease store must declare the same one
  (`[application.store-backend-mismatch]`, `[application.store-backend-undeclared]`), with an
  explicit opt-out that names the guarantee lost (`LeaseCheck.WithoutDoubleChargeProtection`).
- **Then the mark, then the key, then the write**, as #471's reference SQL; a replay advances the
  mark and returns the stored result, the write not run.
- **A durable singleflight:** concurrent calls on one key of one instance share the first's promise;
  across instances the transaction serializes them.
- **SQLite runs the work synchronously**, with a guard: its transactions are one synchronous group
  of statements on one connection shared by every store, and they do not nest. An asynchronous
  work rolls back with `FencedEffectAsyncWorkError`. PostgreSQL (#482) may wait: one client per
  transaction.
- **Limits are settings, not code:** `@Application({ fencedEffects: { maxResultSize, retention } })`,
  64 KB and 24 h by default; the recovery sweep removes rows past the retention, never when a tree
  ends.
- **One published contract suite** (`fencedEffectContract`) that the in-memory, SQLite and
  PostgreSQL stores run.

## Consequences

- One call replaces a service, a repository and their DDL in every application; flow-patterns'
  credit desk charges with it and keeps no key of its own.
- No I/O inside a SQLite effect: a step calls its API before or after the effect, never in it.
- A fenced effect is exactly-once only for rows of the store's database. HTTP APIs, email and
  webhooks still need their own `Idempotency-Key` and `fence.confirmNow()` (#471).
- A fourth store means implementing the four steps in its own transaction and passing the suite.
