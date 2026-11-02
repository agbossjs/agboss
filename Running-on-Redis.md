# Running on Redis

[`@agboss/redis`](https://github.com/agbossjs/redis) keeps the **coordination stores** of several
instances on one Redis (#527, #693): execution leases, the `AnyInstance` child queue and provider
rate limits. Everything else — threads, checkpoints, fenced effects, outbound calls, pauses,
records, the lease log and the kept execution ids — stays in PostgreSQL
([Running-on-PostgreSQL](Running-on-PostgreSQL)) or MongoDB. This page is the core's view: what it
provides, which layouts are safe, what it assumes of the server, and how it is proved. Every
guarantee with its assumptions is on [Guarantees](Guarantees).

## The stores

| Contract | Store | On Redis |
| --- | --- | --- |
| `ExecutionLeaseRepository` | `RedisExecutionLeaseRepository` (abstract, `static backend = "redis"`) | one hash per tree; each operation one Lua script; expiry by the server's `TIME` inside the script; the epoch only grows |
| `ChildExecutionQueueRepository` | `RedisChildExecutionQueueRepository` | a hash per child and one sorted set of the queued — the deepest first, then the longest waiting; save, claim and complete each one script |
| `RateLimitRepository` | `RedisRateLimitRepository` | slots, sliding windows and pauses, each operation one script, on the framework's `Clock` (A10) |

Why only these: the one-backend rule (#526) binds the fenced-effect and outbound-call stores to the
lease store; rate limits, the queue and the lease log are on any backend. Rate limits and the queue
are pure coordination. The lease log is a record (it goes into exported history), the tree store
keeps undo marks (P5) and the mesh store keeps answers: they stay with the durable rows.

The kept execution ids (#591) are never kept in Redis: the lease store is abstract, and a subclass
names the durable store that keeps them — the application's PostgreSQL or MongoDB lease store,
constructed inside it, never listed:

```ts no-check: @agboss/redis and @agboss/postgres are packages of their own repositories, not installed here
@Injectable({ deps: [RedisConnection, StoreClock, ApplicationContext, PostgresConnection] })
export class AppExecutionLeases extends RedisExecutionLeaseRepository {
  constructor(redis: RedisConnection, clock: StoreClock, app: ApplicationContext, pg: PostgresConnection) {
    super(redis, clock, app, new PostgresExecutionLeaseRepository(pg, clock, app));
  }
}
```

## Redis leases and a durable fenced write

A fenced effect or an outbound call refuses a holder whose lease was just taken over — even when
the zombie reaches the write first — by reading the lease in the write's own transaction, under its
lock ([ADR-0026](ADR-0026-Fenced-effects-check-the-lease-in-the-same-transaction), A2). A Redis lease
cannot be in a PostgreSQL or MongoDB transaction. Checking it from inside one leaves a gap: the lease
expires and another instance takes it between the Redis check and the commit, and the database may
apply a `COMMIT` after any deadline the client checked before sending it. A high-water mark of
tokens alone lets a zombie that wakes before the new holder's first write through. So the
combination cannot meet P1 and is **refused**: a Redis lease store beside a fenced-effect or
outbound-call store of another backend fails assembly with `[application.store-backend-mismatch]`.
The rule is not relaxed for Redis.

The layouts that hold:

- **The Redis queue and rate limits, everything else on PostgreSQL or MongoDB** — leases included.
  The layout for payments: no atomic step spans the two databases.
- **Redis leases, queue and rate limits, no fenced-effect or outbound-call store** — for applications
  that make no fenced write and no outbound call (`storeConformance`'s coordination set, `without:
  ["executionLeaseEvent", "fencedEffect", "outboundCall"]`).

## What it assumes of the server

`RedisConnection` refuses to start, naming each setting found short, unless the server:

- keeps every acknowledged write — `appendonly yes`, `appendfsync always`, `no-appendfsync-on-rewrite
  no` — and never evicts a key — `maxmemory-policy noeviction` (an evicted lease key starts its epoch
  at 1 again): `RedisDurabilityError`, unless `redisDurabilityOptOut: "acknowledged-writes-may-be-lost"`
  accepts the loss;
- is a primary, not a replica, and not a cluster: `RedisDeploymentError`, no opt-out.

A refused `CONFIG GET` or `INFO` is refused too. **One durable primary, no automatic failover**
([Guarantees](Guarantees) A14): Redis replicates asynchronously, so a promoted replica may lack an
epoch the primary acknowledged and grant it again — two holders of one token. `WAIT` does not close
it (a write whose `WAIT` timed out is still applied, and a failover may promote a replica that
missed it). A Sentinel cannot be seen from the client; running none is the operator's part. After a
manual failover every instance is stopped before the promoted server serves leases.

Lease keys are never deleted or expired (the epoch must only grow): about 150 bytes per tree, for
good — size `maxmemory` for it; a full server refuses writes, and the core hands the tree over.

## How the stores are proved

- `storeConformance` on the three stores (`tests/contracts/store-conformance.test.ts`): the lease,
  queue and rate-limit contracts, the store set, and the interleaving explorer on the lease store
  alone (#694: every schedule of two instances 8 steps deep, 200 seeded walks of three, the second
  clock ± lease/2, ± lease, ± 10 × lease, both #520 races).
- It bites (`tests/contracts/sabotage.test.ts`): leases decided on the caller's clock fail the
  explorer's `one-live-holder`; a take made of a read and then a write fails the lease contract's two
  take races (#697), and only those.
- The fault suite (`tests/faults/`): its 23 scenarios with the Redis queue and rate limits beside the
  core's SQLite fencing set, `children-once` and `linearizable` included — it found #699.
- A real crash (`tests/crash/`): `docker kill -s KILL` on the server. With the required settings
  every acknowledged epoch survives and the next take continues from it; with the append-only file
  off (opted out) the crash loses epochs and the next take grants one again.
- The one-backend rule on `createApp` (`tests/layout/`): Redis leases beside a fenced-effect or
  outbound-call store of another backend are refused; the supported layouts assemble.
- The server's own clock (`tests/integration/`): a store clock decades off changes no expiry.
