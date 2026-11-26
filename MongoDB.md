# MongoDB

`@agboss/mongodb` ([agbossjs/mongodb](https://github.com/agbossjs/mongodb), #527) keeps every store
of an application on one MongoDB **replica set**: leases and execution ids, records and threads,
trees, pauses, the child queue, checkpoints, the fenced effect with business keys, the audit log,
the cost ledger, the execution history, rate limits, mesh requests and the calls that leave the
system. It is the second full store set after PostgreSQL, and the first on a database without SQL
transactions — so it is also the proof that the store contracts are not shaped around SQL
([Your own store](Your-own-store)).

## The stores

The lease, fenced-effect and outbound-call stores declare `static store = { backend: "mongodb" }`: list the
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
    MongoExecutionAuditLogRepository,
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

An application that serves A2A (`@A2AEndpoint`) also lists `MongoA2ATaskRepository` (#824): a message
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
- **The cancel's fence** (#909, #1117, [ADR-0030](ADR-0030-A-cancel-is-a-fence)) — the mark is the
  field `cancelRequestedAt` of the tree's own lease document `(tenantId, rootExecutionId)`, kept as
  the lease documents are: **permanent** — every write of the document keeps it (`acquire` is an
  update of the stored document, never a replacement) and no retention removes it. `requestCancel`
  is one upsert (a pipeline keeping the first value) outside any transaction; a cancel before the
  tree's first `acquire` upserts a **seed document** — token 0, released, empty holder, never held —
  so that `acquire` is token 1 with no takeover. The fenced effect and the outbound call
  (`saveIfAbsent`, `markPending`) check it in their transaction after the lease, the scope's mark
  and (for an effect) the key's stored result: the root's document is *written* first (a counter
  nothing reads — an update that changes nothing is skipped and locks nothing), then read, and a
  set `cancelRequestedAt` refuses the write with `ExecutionError.CancelFenced`; an undo's key is not
  refused. For a root's or a `SameInstance` key that document is the lease `checkFence` already
  wrote; for a child's key it is its root's, seeded in the same transaction when it does not exist
  yet, so a document always exists to conflict on. The cancel either waits for a transaction that
  already wrote the document or commits first, and the transaction's later write conflicts and runs
  again on a snapshot that holds it; the price is that fenced writes of one tree's `AnyWorker`
  children conflict and retry. An `acquire` that finds no document and inserts the first lease can
  lose to a cancel's seed (a duplicate key): it takes the seed instead. **Schema version 4**
  (`execution-cancel-mark`): no collection, no index — run `agboss-mongodb migrate` with no
  instance of an older version running,
  then start the version that writes it: an older instance neither writes nor reads the field, so
  the fence of [ADR-0030](ADR-0030-A-cancel-is-a-fence) holds only then.
- **The pause store** (#938, contract v2) — a pause change is one compare-and-set on the pause's
  document in a transaction: the deadline (`deadlineAt`, extension) sits in the filter, so of two
  instances exactly one records an expiry or an extension, and the per-recipient notices are
  appended in the same transaction, in order (`noticeOnce` is a guarded upsert, not a duplicate-key
  error inside the transaction). A not-taken answer is kept with its answer and `actor`, and a
  later save is ignored. An extension (#1099, #1148) is one `findOneAndUpdate`-style compare-and-set
  whose filter holds "pending, the stored deadline is still the one the caller read
  (`previousExpiresAt`), after the caller's `at`, earlier than the new one" — the loser and a write
  after the deadline change nothing. `renewNotice` (#1131) is one conditional update of the
  mailbox (its token, `claimedUntil > at`, never earlier than it was), and the scans for expiries
  and reminders take a keyset `after` `(at, tenantId, pauseId)`. It is **schema version 3** (`pause-deadlines-and-notices`; the cancel's fence above makes it 4) — stop the
  old instances, then run `agboss-mongodb migrate`; it backfills the pause channels once, so a pause an
  older instance writes afterwards has none.
- **A write whose outcome is unknown** (#1017) — the driver sends a lost `commitTransaction` and a
  retryable write once more, and the server answers the retry from its transaction number: after one
  reset the real outcome is learned and nothing is unknown. What still fails is read by whitelist:
  every single-command write of every store outside a transaction (not only a lease's), and every
  transaction's commit. A write inside a transaction is left as it is: its commit decides. Only an
  error that proves the write was not applied is known and rethrown as it is; every other one
  rejects with `StoreError.OutcomeUnknown` (source `Transport`): under a lease the holder hands the
  tree over, the next one reads what was left, and the work is never run again for it. The client's
  `socketTimeoutMS` is forced to 300 s, so that a retry always falls inside the server's receipt of
  the first attempt.
  - **Known codes of a server reply** (a `MongoServerError`): 2 (BadValue), 9 (FailedToParse), 14
    (TypeMismatch) and 40 (ConflictingUpdateOperators), the refusals of a command's form, for every
    write; and 112 (WriteConflict), 121 (DocumentValidationFailure), 11000, 11001 and 12582
    (duplicate key), the replies about one document, for a write of one document.
  - **`updateMany` and `deleteMany`** are not atomic, the documents before the failing one stay
    written: their per-document replies (112, 121, 11000, 11001, 12582) are unknown; only 2, 9, 14
    and 40 are known.
  - **A bulk write** is known only when every one of its per-operation errors is a known code, none of
    its operations was applied, and it met no write concern error.
  - **Every commit error is unknown**, whatever it says (`NoSuchTransaction` 251, a transient label, a
    transport error, a write concern error): the driver retries a commit by itself, so the error
    seen is the last attempt's, and the first may have committed.
  - **Unknown, so**: a transport error or timeout, a pool or selection error, a write concern error,
    `NotWritablePrimary` and every other code (`Unauthorized` 13 too), a bulk write that failed as a
    whole, an error with no code. A read is never classified.

  Fault scenario 23 asks that one reset leaves the charge applied once with no hand-over, 23b that a
  reset which persists across the retry hands over and replays.
- **A reassigned pause** (#946) — `reassignByTenantIdAndPauseId` is one transaction: the old pause is
  closed `Cancelled` / `Reassigned` by the compare-and-set of an answer's (pending, its deadline after
  `at`: of two racing reassignments, or one and an answer, one applies) and the replacement is
  inserted unsent, its step key `<original>~r<n>` read from the tree's step keys in the same
  snapshot. The re-send scan reads the partial index `reassigned_unsent` `(askedAt, tenantId,
  pauseId)`; the retention keeps a reassigned pause while its replacement is stored.
- **One instance's own calls** on one lease or business key run in the order they were made: a
  MongoDB transaction takes no lock it waits on — of two transactions on one document the one that
  writes second conflicts — so without it the call that reached the server first would win, not
  the one called first.
- **Everything else** — one command on one document (rate limits keep a key's slots and windows in
  one document, changed by one update pipeline), or a transaction where several documents must
  change together (the cost ledger's counters of one save, a task's pending writes).
- **Order** "as appended" is a sequence document's `$inc`, never a client clock or an `ObjectId`.

## The schema and its versions

The collections, their indexes and the ledger's pruning mark are a versioned schema, recorded in
`agboss_schema` and migrated explicitly by `agboss-mongodb migrate` (#891). Each version is one
migration, applied in order. An upgrade that changes the schema is: stop every instance of the old
version, run `migrate`, start the new one (#1104, ADR-0034). With migrations pending on an already
migrated database, `migrate` refuses while an execution lease is live on the server's clock
(`MongoLiveLeasesError`, `mongodb.live-leases`: `count`, up to 5 sorted `holders`); `--allow-live-leases`
(`allowLiveLeases: true`) migrates anyway, and `SchemaSetup.MigrateOnStart` is not guarded. An idle old
instance holds no lease and is not seen. As a backstop, a channel-filtered page of pauses gives a pause
with no `channel` its channel from its record before it reads:


| Version | Migration | What it adds |
| --- | --- | --- |
| 1 | `stores` | every collection with the simple collation, their indexes, the ledger's mark |
| 2 | `checkpoint_latest_by_step` | the checkpoints' index `latest_by_step` — `{ threadId, namespace, step: -1, checkpointId: -1 }` (#962) |
| 3 | `pause-deadlines-and-notices` | the pause store's contract v2 (#938): deadlines and notices; backfills the pause channels |
| 4 | `execution-cancel-mark` | the cancel's mark as the field `cancelRequestedAt` of the tree's lease document (#909, #1117); no collection, no index — it makes an older build refuse the database |

A database stays at the version of the build that migrated it: run the command of the build you deploy.

**`latest_by_step`** (#962). `MongoCheckpointSaver.latestByStep` reads a marked thread's newest
checkpoint by LangGraph's step ([Your own store](Your-own-store#the-checkpoint-savers-optional-latestbystep-962))
with one sorted `findOne` on that index: one document examined, 1.4 ms on 10 000 checkpoints where
listing and sorting the namespace took 3.7 s. `step` is a field of the checkpoint's own document,
written by the same replace as the checkpoint. **A checkpoint written before has no `step`**: the
first `latestByStep` of its thread and namespace gives each one (about 100 ms for a thread of 2 000
checkpoints, once per thread; an indexed look then finds none missing), so the migration rewrites no
data. A pod of an older build that keeps writing leaves checkpoints without a `step` too; the next
read of their thread gives them one.

**The rollout**:

- **Stop, migrate, deploy** ([ADR-0034](ADR-0034-Schema-upgrades-stop-the-old-version-first)): stop every
  instance of the old version, run `agboss-mongodb migrate` (a Kubernetes Job, a pipeline step), start the
  new version — or `mongodbSchemaSetup: SchemaSetup.MigrateOnStart` for a single instance. This is not a
  rolling upgrade: a Helm `pre-upgrade` or Argo CD `PreSync` Job runs while the old pods serve, so use
  it only for an upgrade that changes no schema ([Deploying on Kubernetes](Deploying-on-Kubernetes#upgrading-across-a-schema-change)).
- **`migrate` and a start that migrates both refuse over live leases.** `migrate` (and
  `migrateMongodb`), with migrations pending on an already migrated database, finds the execution
  leases that are not released, finished or superseded and expire after the **server's** clock, and
  fails with `MongoLiveLeasesError` (`mongodb.live-leases`: the count and up to 5 holders; nothing is
  applied). A start with `SchemaSetup.MigrateOnStart` is held to the same rule (#1260): it waits for the
  leases to lapse — twice the longest lease left, at least a minute and at most ten, polled each second on
  the application's `Clock` — so a stopped single instance's own leases lapse and the start goes on; a
  lease that is still live then (an old pod that keeps renewing) fails the start with the same error. A
  database that is already current, or was never migrated, is not looked at. `--allow-live-leases` /
  `allowLiveLeases: true` in the connection's settings / `mongodbAllowLiveLeases: true` in the
  environment migrates over live leases, for an operator who accepts the risk. An idle old pod holds
  no lease and is not seen.
- **A new pod on a database that was not migrated does not start**: `MongoSchemaMissingError`,
  which names the command. Nothing is created by a start that checks (`SchemaSetup.Check`, the
  default), so the pods need no right to change the schema.
- **An old pod is refused after it**: once the database is migrated, a pod of a build that needs an
  older version that restarts gets `MongoSchemaTooNewError` — migrations are never rolled back, so
  roll the application forward, or run the newer image. Pods already running keep running — and keep
  writing in the old shape, which the check at start cannot see. That is why the old instances are
  stopped **before** `migrate`, and `migrate` runs right before the new ones start, not days before.

## Retries

| What fails | What the driver does | What the store guarantees |
| --- | --- | --- |
| a transient transaction error (a write conflict, a step-down before the commit) | aborts the attempt — none of its writes is seen — and runs it again from the start, for up to 120 s | the work may run again: it does nothing outside its session; one business row, `Ran` once |
| a commit of unknown outcome (the reply lost, a write-concern error) | commits the same transaction again; the server commits it once | the work is not run again |
| a commit that fails without either label, or past 120 s | rejects — the transaction may have committed | the next call on the key replays what it stored |
| a single-document write whose reply was lost | retries it once; the server answers the first outcome | no epoch counted twice; an id kept is told `true` |

Each row is a test against the server's own fail points (`tests/integration/retries.test.ts`).

## A long fenced work can cost the tree its lease (#1334)

A fenced effect's transaction writes the tree's lease document, and a child's writes its root's, so every lease renewal of the root, a single-document write, sent while a fenced `work` is open waits for its transaction. The core bounds a background or checkpoint renewal at 5 s (`RENEW_BOUND`) and a timed-out one is an ordinary store error: the holder goes on. Renewals tick every 7.5 s of a 30 s lease and the holder trusts the lease 29 s after the last confirmed one, so two failed ticks in a row are survived ([a store call that never answers](Several-instances#a-store-call-that-never-answers-928), [Guarantees](Guarantees) P8). A work, the root's or any child's, that blocks every renewal for about three ticks (roughly 20 s or more) costs the tree its lease: the holder stops at its fence and the tree is recovered by another instance once the lease lapses. Safety holds: every fence stands and nothing is charged twice; what is lost is liveness, up to one lease. A leased call that waits on the same document (`fence.renewNow()` before an outbound send, a write of the root's own under its lease) hands the tree over: MongoDB has no command-timeout option, so it ends at the time the holder still trusts its lease. The server's `transactionLifetimeLimitSeconds` (60 s by default) aborts a longer work. Keep a fenced `work` to its database writes, short, and do the slow part, a call to another system, outside it.

## A stop against a quiet server

`MongoConnection.onDestroy` and the child queue's watch close the driver's topology of each client
beside its `close()` (the driver's `close()` takes no `force` and waits for the server to end its
sessions and kill its cursors first). When calls are in flight at the stop, the sockets go at once;
otherwise after a 1 s grace, so an orderly close on a healthy server ends sooner and tells it about
its sessions. A connection attempt whose handshake the server never answers has no handle in the
driver: it ends by the client's own `connectTimeoutMS`. An `execute()` the stop abandons settles with
`ApplicationStoppingError` (`app.stopping`). Proven by a socket count against a paused server
(`tests/integration/close-quiet-app.integration.test.ts`).

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
