# MongoDB

`@agboss/mongodb` ([agbossjs/mongodb](https://github.com/agbossjs/mongodb), #527) keeps every store
of an application on one MongoDB **replica set**: leases and execution ids, records and threads,
trees, pauses, the child queue, checkpoints, the fenced effect with business keys, the lease log,
the cost ledger, the execution history, rate limits, mesh requests and the calls that leave the
system. It is the second full store set after PostgreSQL, and the first on a database without SQL
transactions — so it is also the proof that the store contracts are not shaped around SQL
([Your own store](Your-own-store)).

## The stores

The lease, fenced-effect and outbound-call stores declare `static backend = "mongodb"`: list the
three together ([Your own store → One transactional backend](Your-own-store#one-transactional-backend-526)).

```ts no-check: needs @agboss/mongodb — the providers of an application on MongoDB alone
@Application({
  name: "desk",
  version: "1.0.0",
  providers: [
    MongoCheckpointSaver,
    MongoChildExecutionQueueRepository,
    MongoCostLedgerRepository,
    MongoExecutionHistoryRepository,
    MongoExecutionLeaseEventRepository,
    MongoExecutionLeaseRepository,
    MongoExecutionRecordRepository,
    MongoExecutionTreeRepository,
    MongoFencedEffectRepository,
    MongoMeshRequestRepository,
    MongoOutboundCallRepository,
    MongoPausedExecutionRepository,
    MongoRateLimitRepository,
  ],
})
export class DeskApplication {}
```

A fenced effect's work gets the transaction, `{ session, db }`, and writes its business documents
with `{ session }` — a write without it is outside the guarantee.

An application that serves A2A (`@A2AExpose`) also lists `MongoA2ATaskRepository` (#824): a message
and its task are accepted in one transaction, so the same `messageId` sent to two pods at once
starts one execution; without it the application does not assemble (`[a2a.task-store-not-shared]`,
[A2A](A2A)).

## What the deployment must give

The connection (`MongoConnection`, one `MongoClient` per instance) refuses to start on less, each
with a named error:

| Setting | Required | Why |
| --- | --- | --- |
| Deployment | a replica set (one member for development) or a sharded cluster | a standalone has no majority and no transactions |
| Write concern | `w=majority`, `journal=true` | a write acknowledged by fewer than a majority is rolled back by a failover: an epoch goes back, two owners |
| Read concern | `majority`; transactions `snapshot` (or `majority`) | a weaker read can see a write a failover rolls back |
| Read preference | `primary` | a secondary's lease is stale |
| Retryable writes | on | a write whose reply a failover lost is retried exactly once — never an epoch counted twice |
| Collation | simple (binary) on every store collection | a locale's collation makes `Zoë-17` and `zoe-17` one business key |

And what no setting can enforce — the assumptions of [Guarantees](Guarantees) (A14):

- **The members' clocks are synchronized** (NTP, slewed). A lease's expiry is the server's `$$NOW`
  inside each command, on the primary; after a failover the new primary's clock decides, so a
  member whose clock differs is a step of the database's clock (A3).
- **Transactions are short**: `transactionLifetimeLimitSeconds` (60 s by default) aborts a fenced
  effect's work that runs longer.
- **The fault suite runs on a replica set.** A sharded cluster is accepted by the start check, but
  not tested.

## How each contract is atomic

- **Leases** — one conditional single-document command per operation: `acquire` a
  `findOneAndUpdate` matched only by a takeable lease (not finished, released or expired at
  `$$NOW`), then, for a tree with none yet, an upsert matched only by "no lease document" — MongoDB
  allows no `$expr` in an upsert's filter, and a held lease makes the insert a duplicate `_id`.
- **The fenced effect and the outbound call** — one multi-document transaction each. **A read in a
  MongoDB transaction locks nothing**, so the fence check is a *write*: the lease document is
  touched first (the server's time of the check and a counter — an update that changes nothing is
  skipped and locks nothing, which a test's fixed clock produces), then read. A take, a renewal or
  a close of that lease either committed before the touch, which conflicts (`WriteConflict`, a
  `TransientTransactionError`: the driver runs the transaction again and reads it), or waits for
  the transaction to end. A business key is locked the same way, before the work runs.
- **One instance's own calls** on one lease or business key run in the order they were made: a
  MongoDB transaction takes no lock it waits on — of two transactions on one document the one that
  writes second conflicts — so without it the call that reached the server first would win, not
  the one called first.
- **Everything else** — one command on one document (rate limits keep a key's slots and windows in
  one document, changed by one update pipeline), or a transaction where several documents must
  change together (the cost ledger's counters of one save, a task's pending writes).
- **Order** "as appended" is a sequence document's `$inc`, never a client clock or an `ObjectId`.

## Retries

| What fails | What the driver does | What the store guarantees |
| --- | --- | --- |
| a transient transaction error (a write conflict, a step-down before the commit) | aborts the attempt — none of its writes is seen — and runs it again from the start, for up to 120 s | the work may run again: it does nothing outside its session; one business row, `Ran` once |
| a commit of unknown outcome (the reply lost, a write-concern error) | commits the same transaction again; the server commits it once | the work is not run again |
| a commit that fails without either label, or past 120 s | rejects — the transaction may have committed | the next call on the key replays what it stored |
| a single-document write whose reply was lost | retries it once; the server answers the first outcome | no epoch counted twice; an id kept is told `true` |

Each row is a test against the server's own fail points (`tests/integration/retries.test.ts`).

## The proofs

- `storeConformance` on every store, nothing left out, the interleaving explorer included (every
  schedule of two instances 4 steps deep, 50 seeded walks of three).
- The fault suite, every scenario, real pods on the replica set's primary — each pod by a direct
  connection through a proxy of its own, so the proxy carries every byte; writes still wait for a
  majority of the members.
- Broken stores fail: leases on the caller's clock (the store's-time cases and `one-live-holder`),
  a check-then-write `acquire` (the races of two takes of a free lease, #695 — it passed every lease
  case before), a fence check that only reads (the hand-over during an open fenced write, #695).
- A failover of the three-member test replica set, replication stopped: a lease written at `w=1`
  is lost and taken again at the same epoch — two owners —; at `w=majority` there is one
  (`tests/integration/failover.test.ts`).
