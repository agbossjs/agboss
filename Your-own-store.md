# Your own store

Any database can back an AGBoss application if its stores pass the contract suites the core's
in-memory and SQLite stores pass ([Several instances](Several-instances#writing-your-own-store-the-published-contract-suites-481)).
This page is for the author of such a store — agbossjs/postgres is the first, agbossjs/mongodb and
agbossjs/redis are next. It covers:

- what each contract must do in **one atomic step**;
- why that step is what stands between a crash and a **double charge** or a **second owner**;
- how to get that step on SQL and on databases without SQL transactions;
- how to prove it with `storeConformance` (#526), and under real faults with `faultSuite` (#484).

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
    backends, and what to list instead: a lease store on the fencing store's backend (the core's,
    `SqliteExecutionLeaseRepository` for `"sqlite"`, else "a lease store declaring backend
    `"postgres:billing"`"), or a fencing store on the leases' backend (#539);
  - a store that declares none (the fencing store or its lease store) fails with
    `[application.store-backend-undeclared]`;
  - two listed stores of one fencing contract, or two lease stores, fail with
    `[di.ambiguous-implementation]`, naming both with their backends — at assembly, not at the
    first call (#539).

  Every violation of the layout is reported at once.
- **The opt-out** is `static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection`, and its name
  says what it gives up: the lease is read outside the write's transaction, so a holder whose lease
  was just taken over can still write. Such a store is not checked. Every start warns
  `[application.lease-check-not-atomic]`, which is an error under `agboss check --strict`. Such a
  store is **not conformant for fencing**: it gives no double-charge protection and must never back
  payments. `storeConformance` proves only what it does not give up
  ([An opted-out store and `storeConformance`](#an-opted-out-store-and-storeconformance-543)).
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

**The store's time decides a lease's expiry (#533)** — never the calling instance's clock, which
may run ahead or behind the others. Inject `StoreClock` (`@Injectable({ deps: [PostgresConnection,
StoreClock, ApplicationContext] })`): in production (`storeClock.isDatabaseTime`) every statement that
takes, renews, yields, reclaims, fences or closes a lease reads the database's own time once,
inside that statement — PostgreSQL `clock_timestamp()` in a CTE, MongoDB `$$NOW`, Redis `TIME` in
the script; with a test's clock injected (`isDatabaseTime` false, `testWith` and the contract
suites' virtual-time cases) the statement takes `storeClock.now()` as a parameter instead, so the
suites can move time. Every take and renewal answers the time left, `remaining = expires_at − now`
of that one statement (`remainingOf(expiresAt, now)`, whole ms, rounded down) — `renew` returns it,
`undefined` once the lease is over; `acquire` and `reclaim` return it on the lease. The holder
trusts its lease for `remaining − 1 s` from the moment it **sent** the request, on its monotonic
clock, so neither the database's clock nor its own wall clock is ever compared with another's. A
renewal never shortens a live lease. Build the contract target from `seam.storeClock`: the
suites' "store's time is the authority" cases run on real time with the other instance's own clock
(`seam.clock`) off by ± lease/2, ± lease and ± 10 × lease, and a store that reads it fails them.

```sql
-- $now: clock_timestamp() in production, the test's clock (a parameter) when one is injected
WITH t AS (SELECT clock_timestamp() AS now)
UPDATE agboss_execution_leases SET expires_at = t.now + make_interval(secs => $5 / 1000.0)
  FROM t
  WHERE tenant_id = $1 AND root_execution_id = $2 AND holder_instance_id = $3 AND lease_epoch = $4
    AND NOT released AND expires_at > t.now
  RETURNING floor(extract(epoch FROM expires_at - t.now) * 1000) AS remaining;  -- no row: over
```

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
WHERE NOT l.finished AND (l.released OR l.expires_at <= $5)   -- $5: the store's now (#533)
RETURNING lease_epoch;                                       -- no row: refused
```

`renew`, `release`, `yield` and `finish` are one `UPDATE … WHERE tenant_id = $1 AND
root_execution_id = $2 AND holder_instance_id = $3 AND lease_epoch = $4 AND NOT released` each, and
succeed only when exactly one row changed; `renew`, `yield` and `reclaim` add `AND expires_at > $5`
(the store's now, read in that statement, #533).

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
each fencing store's class declares `static backend`, the same as the set's lease store
(`stores.executionLease`) — unless it opts out —, and that the lease store its own contract ran on
is of that backend too (#542), so the set will assemble beside its own leases and its races were
proven on them.

<!-- snippet-context
declare class PoolClient { query(sql: string): Promise<void>; }
import {
  ExecutionLeaseEventRepository,
  ExecutionLeaseRepository,
  OutboundCallRepository,
  RateLimitRepository,
  type ApplicationContext,
  type Clock,
  type StoreClock,
} from "@agboss/core";
import type { FencedEffectStores } from "@agboss/core/testing/contracts";
declare class Pool { query(sql: string): Promise<void>; }
declare const pool: Pool;
declare const PgLeases: new (pool: Pool, clock: StoreClock, application: ApplicationContext) => ExecutionLeaseRepository;
declare const PgLeaseLog: new (pool: Pool) => ExecutionLeaseEventRepository;
declare const PgCalls: new (pool: Pool, clock: StoreClock) => OutboundCallRepository;
declare const PgRateLimits: new (pool: Pool, clock: Clock, application: ApplicationContext) => RateLimitRepository;
declare function pgFencedEffects(pool: Pool, clock: StoreClock, application: ApplicationContext): FencedEffectStores<PoolClient>;
-->

```ts
// tests/store-conformance.test.ts — in the store's own repository, run by vitest
import { storeConformance } from "@agboss/core/testing/contracts";

storeConformance({
  name: "PostgreSQL",
  reset: () => pool.query("TRUNCATE agboss_execution_leases, agboss_fenced_effect_results"),
  stores: {
    executionLease: (seam) => new PgLeases(pool, seam.storeClock, seam.application),
    executionLeaseEvent: () => new PgLeaseLog(pool),
    fencedEffect: (seam) => pgFencedEffects(pool, seam.storeClock, seam.application),
    outboundCall: (seam) => ({
      calls: new PgCalls(pool, seam.storeClock),
      leases: new PgLeases(pool, seam.storeClock, seam.application),
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
  - `[store-conformance.unknown-store]` is a key of `stores` that names no contract (a typo such as
    `rateLimits`): its store would never be tested (#542);
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

### An opted-out store and `storeConformance` (#543)

A fencing store that declares `static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection` says it
reads the lease outside its write's transaction. That is the author's statement, and no case result
overrides it: such a store passes **no** fencing case, even when it would pass them all.

- **The opt-out is stated twice.** Without `acceptWithoutDoubleChargeProtection: true` in the call,
  every fencing case of that store fails with `StoreConformanceError`
  (`[store-conformance.opted-out-store] <Store> declares LeaseCheck.WithoutDoubleChargeProtection …`),
  and so does its `store set (<name>)` case.
- **With the flag, the fencing cases are skipped**, each with the note "store opted out of the lease
  check: no double-charge protection". The fencing cases are those only an atomic lease check
  passes: a stale, released or expired lease refused, the zombie's write racing the new holder's,
  and the outbound-call lease races. The set's suite shows `gives NO double-charge protection for
  fenced effects` (or `… for outbound calls`) as a passing case, so every report carries it.
- **Every other case still runs** and must pass, and it can fail. Writes and replays, texts,
  business keys, rollback, and one write per key under concurrency are not waived by the opt-out.
  A check-then-write store that is honest about its lease still fails the races of two instances on
  one key.
- **The flag with no opted-out store fails** the case `accepts an opt-out only where a store declares
  one`, so a sound set's report never reads as opted out.

<!-- snippet-context
import type { ExecutionLeaseEventRepository, ExecutionLeaseRepository } from "@agboss/core";
import { storeConformance, type FencedEffectStores, type OutboundCallStores } from "@agboss/core/testing/contracts";
declare const redisLeases: () => ExecutionLeaseRepository;
declare const redisEffects: () => FencedEffectStores<unknown>;
declare const redisCalls: () => OutboundCallStores;
declare const redisLog: () => ExecutionLeaseEventRepository;
-->

```ts
storeConformance({
  name: "Redis effects",
  acceptWithoutDoubleChargeProtection: true, // its fencing cases skipped: never back payments with it
  stores: { executionLease: redisLeases, fencedEffect: redisEffects, outboundCall: redisCalls, executionLeaseEvent: redisLog },
});
```

`fencedEffectContract(target, { acceptWithoutDoubleChargeProtection })` and `outboundCallContract`
take the same option when they are run on their own. Run alone with the flag, the suite shows the
missing protection itself (#566): `gives NO double-charge protection: its store opted out of the
lease check (acceptWithoutDoubleChargeProtection)` passes for an opted-out store, so a report that
hides skipped cases still says it, and fails (`[store-conformance.opt-out-not-declared]`) for a store
that does not opt out. A store opted out through its parent class is opted out too; a subclass
that restates `LeaseCheck.Atomic` runs every fencing case.

### Faults: `faultSuite` (#484)

The contract suites prove the atomic steps on a healthy database, in one process. `faultSuite`
runs the store set under faults, in real processes: several `node` pods on one database, killed
(`SIGKILL`), stopped (`SIGTERM`), frozen (`SIGSTOP` / `SIGCONT`) and cut off their database (a TCP
proxy per pod). After each of its scenarios it checks that no fault turned into a second owner, a
second charge, a lost or doubled child, an undo on a hand-over or a tree that never ended.
[Guarantees across processes](Guarantees-across-processes) lists the scenarios and what each proves.

**1. The store set's module.** Every pod imports it. It exports `faultStores`:
- the store classes, as `@Application({ providers })` lists them;
- the environment they read: the pod's database is the process variable `AGBOSS_FAULT_DATABASE_URL`;
- how the fixture's charge writes its business row in your fenced effect's transaction, and reads
  the committed rows back.

Import the types only (`import type`). A pod runs outside vitest.

<!-- snippet-context
import type { App } from "@agboss/core";
declare class PoolClient { query(sql: string, values?: unknown[]): Promise<unknown>; }
declare class PgConnection { readonly pool: { query(sql: string): Promise<{ rows: { row: string }[] }> }; }
declare class PgLeases {}
declare class PgLeaseLog {}
declare class PgFencedEffects {}
declare class PgCalls {}
declare class PgRecords {}
declare class PgTrees {}
declare class PgHistory {}
declare class PgChildQueue {}
declare class PgPauses {}
declare class PgCheckpoints {}
declare class PgFaultEnvironment { postgresUrl: unknown }
declare function secret(name: string): unknown;
declare function resolveConnection(app: App): PgConnection;
-->

```ts
// tests/faults/postgres.fault-stores.ts — imported by every pod
import type { FaultStores } from "@agboss/core/testing/faults";

export const faultStores: FaultStores<PoolClient> = {
  providers: [PgLeases, PgLeaseLog, PgFencedEffects, PgCalls, PgRecords, PgTrees, PgHistory, PgChildQueue, PgPauses, PgCheckpoints],
  environment: {
    contract: PgFaultEnvironment,
    values: { postgresUrl: secret("AGBOSS_FAULT_DATABASE_URL") },
  },
  businessRows: {
    insert: async (client, row) => {
      await client.query("INSERT INTO fault_business_rows (row) VALUES ($1)", [row]);
    },
    committed: async (app) =>
      (await resolveConnection(app).pool.query("SELECT row FROM fault_business_rows")).rows.map(
        (found) => found.row,
      ),
  },
};
```

Every store must be on the shared database. An in-memory default is not shared between processes,
so list each of: the lease, lease-log, fenced-effect, outbound-call, record, tree, history,
child-queue and paused stores, and the checkpoint saver.

**2. The suite**, in a vitest file of the store's own repository:

<!-- snippet-context
declare const url: string;
declare function freshSchema(): Promise<void>;
-->

```ts
// tests/faults/postgres.faults.test.ts
import { faultSuite } from "@agboss/core/testing/faults";

faultSuite({
  name: "PostgreSQL",
  stores: new URL("./postgres.fault-stores.ts", import.meta.url).pathname,
  database: { url, reset: () => freshSchema() }, // an empty database (and business table) per scenario
});
```

- **`reset`** runs before each scenario. It gives an empty database, and the business table the
  set's `insert` writes.
- **The database proxy.** A `url` with a host and a port (`postgres://…:5432/…`) is reached through
  a proxy per pod, so a scenario can stall or drop one pod's connections. A file's path (SQLite)
  gets a store outage of the same two kinds, inside the pod.
- **`timeScale`** (default 1, the real clock) runs every pod's clock that much faster, from one
  origin, so a lease of 30 s lasts 30 s / `timeScale`. The core runs SQLite at 10. A real database
  should also run at 1 at least nightly: its round trips are real time.
- **`scenarios`** selects scenarios by id. One test file per scenario makes a flake easy to
  probe (`node scripts/flaky-probe.mjs <file> 20`).
- The scenarios run one after another. Each starts at most three pods and kills every pod it
  started at its end. With `AGBOSS_FAULT_DUMP_DIR` set, a failed scenario writes its pods' events,
  the store history and the pods' output there (CI's artifact).

**3. Hold points in your own process tests.** `withHoldPoints(Store)` is your store with the
store hold points (`StoreHoldPoint`) and the history. List it in place of the store. Then, in that
process, `processHoldPoints.arm({ point: StoreHoldPoint.LeaseAcquire, key })` holds the next
`acquire` of `key` before your store is asked, until `release(holdId)`. `onHeld` announces each
held operation. You write no seam of your own to force an order across processes.

## Checklist

- [ ] A lease's expiry is decided by the store's time (#533): the database's, read inside each
      statement, unless `StoreClock.isDatabaseTime` is false (a test's clock, a parameter) — never
      the caller's `Clock`. `acquire`, `renew` and `reclaim` answer `remaining`; the target is built
      from `seam.storeClock`.
- [ ] `acquire` is one atomic step; `renew` / `release` / `yield` / `reclaim` / `finish` match the
      holder and the epoch, and succeed only when one row changed.
- [ ] A lease is live while `expires_at > now` in every statement, for its holder too (#534):
      `renew`, `yield`, `reclaim` and every fence check refuse it at its expiry, `acquire` takes it.
- [ ] A fenced effect's lease check, mark, key, business rows and result are one transaction. The
      work gets that transaction. A throw rolls everything back.
- [ ] Every outbound-call method is fenced. `markPending` / `markCompleted` / `markFailed` are
      compare-and-sets. `leaseStateOf` reads and closes in one step.
- [ ] `checkedEffectName` and `checkedBusinessKey` (#538: a business key's text — no control or
      format character, no lone surrogate, NFC; #547: no space but U+0020, single and inside) run at every fenced method's entry; a business key is
      stored and compared byte for byte — no case-insensitive collation, no trim, no normalization.
      Keys, replays and records use `fencedKeyIdentityOf`, `replayedFromOf`, `storedKeyFactsOf` and `pendingOutboundCallOf`.
- [ ] The lease, fenced-effect and outbound-call stores declare `static backend` (one text for one
      database). The fencing stores declare `static leaseRepository` for unit runners.
- [ ] Every text and JSON value comes back as it was handed over, a NUL character included.
- [ ] `ping()` is one fast round trip.
- [ ] `storeConformance` passes with every store the set has; the ones it lacks are in `without`.
      A store that opts out of the lease check passes only with
      `acceptWithoutDoubleChargeProtection: true`, its fencing cases skipped: it is not conformant
      for fencing and backs no payment (#543).
- [ ] `faultSuite` passes on the set, against a real database, in CI.
- [ ] The README lists the stores together, links this page, and says which backend they declare.
