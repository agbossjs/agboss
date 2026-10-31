# Your own store

Any database can back an AGBoss application if its stores pass the contract suites the core's
in-memory and SQLite stores pass ([Several instances](Several-instances#writing-your-own-store-the-published-contract-suites-481)).
This page is for the author of such a store — agbossjs/postgres is the first, agbossjs/mongodb and
agbossjs/redis are next. It covers:

- what each contract must do in **one atomic step**;
- why that step is what stands between a crash and a **double charge** or a **second owner**;
- how to get that step on SQL and on databases without SQL transactions;
- how to prove it with `storeConformance` (#526).

## The two promises

Everything below serves two promises the framework makes to an application on several instances:

- **One owner at a time.** A tree is moved by the instance that holds its lease. An instance that
  froze, lost its network or died has its lease taken over by another, which continues the tree
  from its last checkpoint. The frozen one may wake up and keep going — a **zombie** — but it can
  no longer *do* anything: every write it attempts carries its lease's token (`leaseEpoch`), and
  the store refuses a token that is not the lease's current one.
- **One effect per key.** A charge, a booking, a mail — a fenced effect (#500) or a call that leaves
  the system (#505) — is made once per key, however many times its step runs again. A replay
  returns the stored result; a zombie's attempt is refused.

Both hold only if the store makes certain checks and writes **one atomic step**. A store that checks,
then writes in a second step leaves a gap. A takeover in that gap gives two owners; two writes in
it give two charges. The contract suites race exactly those gaps, so a store with one fails them.

## What must be atomic, per contract

| Contract | The operation | What must be one atomic step | Without it |
| --- | --- | --- | --- |
| `ExecutionLeaseRepository` | `acquire` | read the tree's lease, decide it is free (released, expired, never finished), write the new holder at `leaseEpoch + 1` | two instances both take a free lease: **two owners** move one tree |
| | `renew`, `release`, `yield`, `reclaim`, `finish` | match the holder **and** the epoch, then write; `renew`, `yield` and `reclaim` only while the lease is live, `expires_at > now` (#534) | a zombie renews or releases the new holder's lease: the new owner loses it mid-step; a holder renews a lease the rest of the system already gave up |
| `FencedEffectRepository` | `saveResultIfAbsent` | the lease check (held, at the key's token, not expired), the scope's high-water mark (raised to the token, a lower token refused), the key's stored result (replayed when there), the business rows, the result — **one transaction** | a zombie's write lands after a takeover, or two calls each find no result: a **double charge** |
| `OutboundCallRepository` | every fenced method | the same lease and mark check, in the same step as the read or the write of the intent | a zombie records or completes an intent the new holder is about to send: **two sends** |
| | `markPending`, `markCompleted`, `markFailed` | a compare-and-set on the state the caller read (status, attempt, attempt owner), one row changed | two instances both resend: **a double charge** |
| | `leaseStateOf` | read the other execution's lease and, if it expired at the token, close it (released, `superseded`) | the holder renews in the gap and keeps sending, while this caller reconciles and resends: **two senders** |
| `ChildExecutionQueueRepository` | `claim…` | pick the next queued row and mark it claimed | two workers run one child: **two owners** |
| `ExecutionRecordRepository` | `complete`, status moves | a compare-and-set from the expected status | a lost update; two outcomes for one run |
| `ExecutionTreeRepository`, `MeshRequestRepository` | `saveIfAbsent` | insert if no row has the key (a unique key) | a request retried on another pod runs twice |
| `RateLimitRepository` | slots, windows, pauses | count and take under one lock | the limit is exceeded under load |
| `ExecutionLeaseEventRepository` | `save` | an append, read back as it was | an operator cannot tell a zombie from a takeover — no atomicity with the lease is needed |

The lease log is never written inside a lease's transaction: the framework writes the row after the
move it records. So it may live on any backend. So may rate limits and the child queue.

## One transactional backend (#526)

A fenced effect checks the lease **in its own transaction**. An outbound call's `leaseStateOf`
closes a lease **in the same step** as it reads it. Both are only atomic when the lease row and the
effect's rows are in **one database**. A PostgreSQL fenced-effect store reading leases kept in
Redis can only check them, then write — the gap is back.

So every fencing store declares where its rows live, and assembly compares the declarations:

```ts no-check: a fragment of a store class — the stores of agbossjs/postgres declare it so
export class PostgresExecutionLeaseRepository extends ExecutionLeaseRepository {
  static override readonly backend: string | undefined = "postgres";
  // …
}

export class PostgresFencedEffectRepository extends FencedEffectRepository<PoolClient> {
  static override readonly backend: string | undefined = "postgres";
  static override readonly leaseRepository = PostgresExecutionLeaseRepository; // unit runners
  // …
}
```

- **`static backend`** is `"<kind>"` or `"<kind>:<database>"`. The built-in stores declare
  `"in-memory"` and `"sqlite"`. Stores on a second PostgreSQL database declare
  `"postgres:billing"`. Two stores share a transactional backend exactly when they declare the same
  text.
- **Assembly** compares each listed fenced-effect or outbound-call store with the application's
  lease store (the listed one, else the in-memory default):
  - two backends fail with `[application.store-backend-mismatch]`, naming both classes and both
    backends;
  - a store that declares none (the fencing store or its lease store) fails with
    `[application.store-backend-undeclared]`.
- **The opt-out** is `static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection`, and its name
  says what it gives up: the lease is read outside the write's transaction, so a holder whose lease
  was just taken over can still write. Such a store is not checked. Every start warns
  `[application.lease-check-not-atomic]`, which is an error under `agboss check --strict`. Use it
  only for a store whose writes are idempotent at the other end anyway.
- **Not bound:** rate limits, the child queue and the lease log. The planned Redis store keeps
  **coordination** stores: leases, rate limits, the queue. An application on Redis leases can then
  list a fenced-effect or outbound-call store only on Redis too (or one that opts out). One on
  PostgreSQL beside Redis leases is refused.
- **An unlisted default fencing store** (the in-memory one beside listed SQLite leases) is not an
  assembly error, so an application that never uses fenced effects need not list one. Its first
  call fails with `FencedEffectStoreMismatchError`.

### The connection is not listed

A store's connection (`PostgresConnection`, `SqliteConnection`, your pool class) is created by the
application's container the first time a store needs it, once per instance. It need not be in
`providers`, not even when `OutboundCalls`, or a component that injects the store's own class,
reaches it through a workflow: the workflow's graph check treats an unlisted class under an
infrastructure implementation as its own registration (#526). A dependency of your store that is an
`InjectionToken` (a value) must still be provided.

## The key's rules: use the core's helpers

A fenced effect's or an outbound call's key comes from `fencedEffectKeyOf(executionContext, name,
{ businessKey?, fingerprint? })`. A store keeps a few rules about it, and `@agboss/core` exports each
one (#526 AC5). Don't copy them:

| Helper | Use |
| --- | --- |
| `checkedEffectName(key.name)` | at the entry of every fenced method, before any statement: `InvalidFencedEffectNameError` for a key built by hand with a name that is not 1–100 of `[A-Za-z0-9._-]` |
| `checkedBusinessKey(key)` | beside it (#538): `InvalidBusinessKeyError`, naming the rule, for a key built by hand whose business key is not a key's text (`keyTextRuleOf`) |
| `fencedKeyIdentityOf(key)` | where the key's row is: the scope, the step's idempotency key and the name, or, with a business key, the tenant, the name and the business key — one text, a key-value store's row key |
| `storedKeyFactsOf(key)` | what the row keeps of the key: its fingerprint and its step |
| `replayedFromOf(key, stored)` | on a row found for the key: another fingerprint under a business key is `IdempotencyKeyConflictError` (never a replay); a row another step wrote is named as `replayedFrom`. It takes a row's `null`s and checks a stored step: a row is never trusted |
| `pendingOutboundCallOf(key, intent, recordedAt)` | the record `saveIfAbsent` writes: the intent, `Pending` under the key's lease and token, its business identity |

## Recipes: SQL

Every time value is a **parameter from the framework's `Clock`**, never `now()` of the database:
the suites move time with a `VirtualClock`, and a store on the database's time fails their
time-based cases.

**A lease, taken in one statement**: the conflict decides, so two instances can't both win.

```sql
INSERT INTO agboss_execution_leases AS l
  (tenant_id, root_execution_id, holder_instance_id, lease_epoch, expires_at, released, finished)
VALUES ($1, $2, $3, 1, $4, false, false)
ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
  holder_instance_id = EXCLUDED.holder_instance_id,
  lease_epoch = l.lease_epoch + 1,
  expires_at = EXCLUDED.expires_at,
  released = false
WHERE NOT l.finished AND (l.released OR l.expires_at <= $5)   -- $5: the clock's now
RETURNING lease_epoch;                                       -- no row: refused
```

`renew`, `release`, `yield` and `finish` are one `UPDATE … WHERE tenant_id = $1 AND
root_execution_id = $2 AND holder_instance_id = $3 AND lease_epoch = $4 AND NOT released` each, and
succeed only when exactly one row changed; `renew`, `yield` and `reclaim` add `AND expires_at > $5`
(the clock's now).

**The boundary (#534): a lease is live while `expires_at > now`, and only then — for every
instance, its holder included.** At `now >= expires_at` it is over: `acquire` takes it (`expires_at
<= now` above), and the holder's `renew` and `yield` are `false`, its `reclaim` `undefined`, its
`confirmNow()` lost and every fenced write at its token refused, whether another instance took it
or not. One comparison everywhere — never `>=` in one statement and `>` in another, never holder
and epoch alone: at the very instant of expiry a takeover and a renewal would both be legal, and a
renewal that wins after `leaseStateOf` or a fence check gave the lease up keeps two owners. The
holder takes its tree again only by `acquire`, at the next epoch, a takeover from itself
(`takenOverFrom` names it). The suites pin it 1 ms before, exactly at and 1 ms after the expiry, for
each of these operations.

**A fenced effect, one transaction**: the lease row is locked first, so a takeover waits for the
commit, or the commit sees the takeover.

```sql
BEGIN;
SELECT lease_epoch, expires_at, released FROM agboss_execution_leases
  WHERE tenant_id = $1 AND root_execution_id = $2 FOR UPDATE;  -- held, at the token, not expired?
INSERT INTO agboss_fenced_effect_marks AS m (scope_key, highest_token, stored_at)
  VALUES ($3, $4, $5)
  ON CONFLICT (scope_key) DO UPDATE SET highest_token = GREATEST(m.highest_token, EXCLUDED.highest_token)
  RETURNING highest_token;                                     -- above the token: refused
SELECT result, fingerprint, origin FROM agboss_fenced_effect_results WHERE … FOR UPDATE;
-- found → replayedFromOf(key, row), the stored result; else the work's own statements, then:
INSERT INTO agboss_fenced_effect_results (…) VALUES (…);
COMMIT;                                                         -- any refusal or throw: ROLLBACK
```

The work gets the transaction (a `PoolClient`) and runs its business statements in it. A business
key's row is the same for every scope of the tenant, so two leases can race on it: give it a
unique key and lock it (`FOR UPDATE`), never only the lease.

**An outbound call**:

- `saveIfAbsent` is `INSERT … ON CONFLICT DO NOTHING`;
- `markPending` is a compare-and-set:
  `UPDATE … SET status = 'pending', attempt = $a, attempt_owner = $o WHERE … AND status = $s AND attempt = $n AND attempt_owner = $p`,
  which wins only when one row changed;
- `markCompleted` and `markFailed` compare the attempt owner the same way;
- `leaseStateOf` is `SELECT … FOR UPDATE` on the lease row, then the conditional close, in one
  transaction.

All of them run after the same lease and mark check.

**A queued child**: `UPDATE … SET status = 'claimed', … WHERE id = (SELECT id … WHERE status =
'queued' ORDER BY depth DESC, queued_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING …`.

SQLite has no row locks. The core's stores run each atomic step in one `BEGIN IMMEDIATE`
transaction, which takes the write lock first. Its work must be synchronous.

## Recipes: databases without SQL transactions

The rule is the same: the lease check, the mark, the key and the business write in one atomic step.
How a database gives that step decides **what it can hold**.

### MongoDB: multi-document transactions

- Transactions need a **replica set** (or a sharded cluster). Use `session.withTransaction(…)`
  with `writeConcern: { w: "majority" }` and `readConcern: "snapshot"`. It retries the whole
  callback on `TransientTransactionError`.
- A read inside a transaction **does not lock**. Make the lease check a **write** instead: a
  conditional `updateOne` on the lease document that matches the token, not released and not
  expired, and touches a field. Then a concurrent takeover conflicts with this transaction
  (`WriteConflict`): one of them aborts and retries, never both commit.
- The result's `_id` is `fencedKeyIdentityOf(key)` (a unique key). The scope's mark is an
  `updateOne(…, { $max: { highestToken: token } }, { upsert: true })` in the same transaction.
- The business documents are written with the same `session`. A business write outside it is
  outside the guarantee.
- Mind `transactionLifetimeLimitSeconds` (60 s by default): a long work aborts. Store a receipt,
  not a document.

```ts no-check: needs the mongodb driver — the shape of saveResultIfAbsent's transaction
await session.withTransaction(async () => {
  const lease = await leases.updateOne(
    { _id: [tenantId, leaseExecutionId], leaseEpoch: token, released: false, expiresAt: { $gt: now } },
    { $set: { checkedAt: now } }, // a write: a concurrent takeover conflicts with this transaction
    { session },
  );
  if (lease.matchedCount !== 1) throw new ExecutionFencedError({ scopeKey, token });
  // …the mark ($max), the stored result by fencedKeyIdentityOf(key), the work(session), the result
});
```

### Redis: one Lua script

- A script (`EVAL`, or a `FUNCTION`) runs **atomically**: nothing else runs on the server while it
  does. So the lease check, the mark, the key and the writes go in **one script**.
- The work can't call back into JavaScript mid-script. A Redis fenced effect's transaction is a
  **buffer of commands** the work fills, which the script runs after its checks.
- In a cluster, every key a script touches must be in **one hash slot**: put the tree in a hash tag,
  `{default:root-1}:lease`, `{default:root-1}:mark`. A business key's row (one per tenant and
  name) is in another slot than the lease. So a Redis store can't make a business-key effect and
  its lease check one script across a cluster.
- **The durability caveat.** Redis acknowledges a write before it is on disk (`appendfsync
  everysec` loses up to about a second on a crash), and replication is asynchronous. A failover can
  lose an acknowledged lease or result. Then two instances may each hold the lease: **two owners**
  after a failover, even with a correct script. `WAIT` narrows this window but does not close it.
  Run Redis with AOF `always` and a single primary for leases, or accept the window. For effects
  whose business rows live elsewhere, keep the fenced effects on that database. The backend check
  then refuses them beside Redis leases, which is the point: fencing on Redis protects only writes
  that are in the same Redis.

```lua
-- KEYS[1] lease, KEYS[2] mark, KEYS[3] result (one hash tag); ARGV: token, now, result, …
local lease = redis.call('HMGET', KEYS[1], 'epoch', 'expiresAt', 'released')
if tonumber(lease[1]) ~= tonumber(ARGV[1]) or lease[3] == '1' or tonumber(lease[2]) <= tonumber(ARGV[2]) then
  return {'fenced', lease[1] or false}
end
local highest = tonumber(redis.call('GET', KEYS[2]) or '0')
if highest > tonumber(ARGV[1]) then return {'fenced', highest} end
redis.call('SET', KEYS[2], math.max(highest, tonumber(ARGV[1])))
local stored = redis.call('GET', KEYS[3])
if stored then return {'replayed', stored} end
-- …the buffered business commands, then:
redis.call('SET', KEYS[3], ARGV[3])
return {'ran'}
```

### DynamoDB: conditional writes and `TransactWriteItems`

- **A single item** is a compare-and-set by itself: `PutItem` / `UpdateItem` with a
  `ConditionExpression`. Taking a lease is one `UpdateItem` with `SET leaseEpoch = leaseEpoch + :one,
  holder = :me, expiresAt = :until`, conditioned on `attribute_not_exists(pk) OR released = :true OR
  expiresAt <= :now` (and not finished). A failed condition (`ConditionalCheckFailedException`)
  means refused.
- **A fenced effect** is one `TransactWriteItems`:
  - a `ConditionCheck` on the lease item (`leaseEpoch = :token AND released = :false AND expiresAt > :now`);
  - an `Update` of the mark with `highestToken <= :token`;
  - a `Put` of the result with `attribute_not_exists(pk)`;
  - the business items.

  Any failed condition cancels all of it (`TransactionCanceledException`, whose
  `CancellationReasons` say which condition). A cancelled result put means the key was stored:
  read it and replay.
- Limits: at most **100 items and 4 MB** per transaction, each item at most once. A transaction
  costs twice the capacity of a plain write. The business rows must be DynamoDB items to be inside
  the guarantee.
- An outbound call's compare-and-sets are single-item conditional updates. `leaseStateOf`'s close
  is an `UpdateItem` conditioned on the token and on the expiry, so a renewal that lands first makes
  its condition fail.

### Cassandra: lightweight transactions, one partition

- A lightweight transaction (`INSERT … IF NOT EXISTS`, `UPDATE … IF col = ?`) is a Paxos
  compare-and-set **within one partition**. A conditional `BATCH` must be in one partition too.
  There is no atomic step across partitions.
- Put the lease, the scope's mark and the step's results in the **partition of the tree**
  (`(tenant_id, root_execution_id)`). The fence check and the write are then one conditional batch:
  `UPDATE leases … IF lease_epoch = ? AND released = false` plus `INSERT results … IF NOT EXISTS`.
- **What it can't hold:** a business key's row (one per tenant and name, from any tree) is in
  another partition than the lease. Its check and its write can't be one step, and neither can
  business rows of another table. A Cassandra store keeps fenced effects to rows of the tree's
  partition, or declares the opt-out with what it loses.
- Read with `SERIAL` / `LOCAL_SERIAL` where the next decision depends on the read. Never mix
  lightweight and plain writes on the same cells: a plain write ignores the Paxos state. Each
  lightweight transaction costs about four round trips.

## Prove it: `storeConformance`

One call runs every contract the store set claims, with the same cases the core's own stores run
(their suites are named `<contract> (<name>)`), and the `store set (<name>)` cases. Those check that
each fencing store's class declares `static backend`, the same as the lease store it checks (or
opts out), so the set will assemble beside its own leases.

<!-- snippet-context
declare class PoolClient { query(sql: string): Promise<void>; }
import {
  ExecutionLeaseEventRepository,
  ExecutionLeaseRepository,
  OutboundCallRepository,
  RateLimitRepository,
  type ApplicationContext,
  type Clock,
} from "@agboss/core";
import type { FencedEffectStores } from "@agboss/core/testing/contracts";
declare class Pool { query(sql: string): Promise<void>; }
declare const pool: Pool;
declare const PgLeases: new (pool: Pool, clock: Clock, application: ApplicationContext) => ExecutionLeaseRepository;
declare const PgLeaseLog: new (pool: Pool) => ExecutionLeaseEventRepository;
declare const PgCalls: new (pool: Pool, clock: Clock) => OutboundCallRepository;
declare const PgRateLimits: new (pool: Pool, clock: Clock, application: ApplicationContext) => RateLimitRepository;
declare function pgFencedEffects(pool: Pool, clock: Clock, application: ApplicationContext): FencedEffectStores<PoolClient>;
-->

```ts
// tests/store-conformance.test.ts — in the store's own repository, run by vitest
import { storeConformance } from "@agboss/core/testing/contracts";

storeConformance({
  name: "PostgreSQL",
  reset: () => pool.query("TRUNCATE agboss_execution_leases, agboss_fenced_effect_results"),
  stores: {
    executionLease: (seam) => new PgLeases(pool, seam.clock, seam.application),
    executionLeaseEvent: () => new PgLeaseLog(pool),
    fencedEffect: (seam) => pgFencedEffects(pool, seam.clock, seam.application),
    outboundCall: (seam) => ({
      calls: new PgCalls(pool, seam.clock),
      leases: new PgLeases(pool, seam.clock, seam.application),
    }),
    rateLimit: (seam) => new PgRateLimits(pool, seam.clock, seam.application),
  },
});
```

- **Each store** is a factory `(seam) => store`, or `{ instance, reset?, close? }` when it needs a
  reset or a close of its own. The set's `reset` runs before each case of a store without its own.
  Every case builds two instances on one backing store, on the case's `VirtualClock`.
- **A set with a lease store must claim the other fencing contracts**: the fenced effect, the
  outbound call and the lease log. Otherwise it lists them in `without`. A set of coordination
  stores (leases, rate limits, the queue on Redis) says `without: ["fencedEffect",
  "outboundCall"]`, and an application on those leases then lists no such store either. A set that
  forgets one fails its test file before any case runs, with `StoreConformanceError`:
  - `[store-conformance.missing-fencing-contract]` names the missing contract and what its cases
    prove;
  - `[store-conformance.lease-store-required]` is a fencing store without its lease store;
  - `[store-conformance.without-implemented]` is a contract both given and left out;
  - `[store-conformance.invalid-without]` is a `without` entry that may not be left out;
  - `[store-conformance.empty]` is a set with no store.
- **The races the suites run**, each round after round, in both orders:
  - a zombie's write racing its lease's release, the next take and the new holder's write of the
    same key: one business row;
  - two instances on one key, and on one business key from two executions;
  - two attempts of one intent;
  - `leaseStateOf` against a late renewal and against a take.

  The core proves they bite: deliberately broken sets fail them, each on the rule it breaks
  (`tests/testing/contracts/broken-store-set.test.ts`): check-then-write, business rows outside
  the transaction, a read-then-close `leaseStateOf`, a lease log on a pre-#508 row schema, and
  stores of no backend or another.
- One function per contract (`fencedEffectContract`, …) is still there for a store run on its own.

### Faults: `faultSuite` (#484)

> Coming with #484. The contract suites prove the atomic steps on a healthy database. `faultSuite`
> will run a store set under faults: a connection dropped mid-transaction, a commit whose answer is
> lost, a slow lock, a failover. It will check that no fault turns into a second owner or a second
> charge. This section will show how to run it beside `storeConformance`.

## Checklist

- [ ] Every time value comes from the framework's `Clock` (a parameter), never the database's.
- [ ] `acquire` is one atomic step; `renew` / `release` / `yield` / `reclaim` / `finish` match the
      holder and the epoch, and succeed only when one row changed.
- [ ] A lease is live while `expires_at > now` in every statement, for its holder too (#534):
      `renew`, `yield`, `reclaim` and every fence check refuse it at its expiry, `acquire` takes it.
- [ ] A fenced effect's lease check, mark, key, business rows and result are one transaction. The
      work gets that transaction. A throw rolls everything back.
- [ ] Every outbound-call method is fenced. `markPending` / `markCompleted` / `markFailed` are
      compare-and-sets. `leaseStateOf` reads and closes in one step.
- [ ] `checkedEffectName` and `checkedBusinessKey` (#538: a business key's text — no control or
      format character, no lone surrogate, NFC) run at every fenced method's entry; a business key is
      stored and compared byte for byte — no case-insensitive collation, no trim, no normalization.
      Keys, replays and records use `fencedKeyIdentityOf`, `replayedFromOf`, `storedKeyFactsOf` and `pendingOutboundCallOf`.
- [ ] The lease, fenced-effect and outbound-call stores declare `static backend` (one text for one
      database). The fencing stores declare `static leaseRepository` for unit runners.
- [ ] Every text and JSON value comes back as it was handed over, a NUL character included.
- [ ] `ping()` is one fast round trip.
- [ ] `storeConformance` passes with every store the set has; the ones it lacks are in `without`.
- [ ] The README lists the stores together, links this page, and says which backend they declare.
