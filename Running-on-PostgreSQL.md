# Running on PostgreSQL

Several instances of one application — pods on different machines, no shared disk — share their
execution trees, budgets, rate limits, history, mesh requests and the calls that leave the system
on one PostgreSQL database through [`@agboss/postgres`](https://github.com/agbossjs/postgres)
(#482, #483). This page is the core's view of it: how to install and wire it, what it assumes of the
database, its limits, and how it is proved. The mechanisms it rests on — the lease, fencing,
recovery — are on [Several-instances](Several-instances); every guarantee with its assumptions on
[Guarantees](Guarantees). The package's own README has each store's tables and SQL.

## Install

```sh
npm install @agboss/core @agboss/postgres
```

`@agboss/postgres` is released with the core as one train and has the core's version:
`@agboss/postgres@0.1.1` declares the peer dependency `@agboss/core` `^0.1.1` and is built and tested
against the `@agboss/core@0.1.1` on npm (`RELEASE_CHECKLIST.md` in agbossjs/agboss). Its own
dependencies are `pg`, `@langchain/langgraph-checkpoint-postgres` and `zod`; the core gets no driver.
PostgreSQL 16 is what its CI runs on.

## Wire the stores

Each store extends one core contract and is listed in `@Application({ providers })` in place of the
in-memory default or the SQLite store — nothing else of the application changes:

```ts no-check: @agboss/postgres is a package of agbossjs/postgres, not installed in this repository
import { Application, secret, type Secret } from "@agboss/core";
import { days } from "@agboss/core/units";
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresCostLedgerRepository,
  PostgresExecutionHistoryRepository,
  PostgresExecutionLeaseEventRepository,
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresExecutionTreeRepository,
  PostgresFencedEffectRepository,
  PostgresMeshRequestRepository,
  PostgresOutboundCallRepository,
  PostgresPausedExecutionRepository,
  PostgresRateLimitRepository,
} from "@agboss/postgres";

// environments/app.environment.ts
export class AppEnvironment {
  postgresUrl!: Secret; // required as soon as one PostgreSQL store is listed
  postgresPoolSize?: number; // this instance's pool: at most this many connections, default 10
  postgresMigrateOnStart?: boolean; // default off
}

// environments/prod.environment.ts
export const environment: AppEnvironment = {
  postgresUrl: secret("DATABASE_URL"),
  postgresPoolSize: 20,
};

@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  executionRecordRetention: days(30),
  providers: [
    PostgresCheckpointSaver, // LangGraph's PostgresSaver on the shared pool
    PostgresChildExecutionQueueRepository, // ChildPlacement.AnyInstance children
    PostgresCostLedgerRepository, // budgets count every pod's spend
    PostgresExecutionHistoryRepository, // agboss records export on any pod
    PostgresExecutionLeaseEventRepository, // the lease log: app.leaseEventsOf
    PostgresExecutionLeaseRepository, // one holder per tree, fenced by epoch
    PostgresExecutionRecordRepository, // threads, records, scores, summaries
    PostgresExecutionTreeRepository, // the shared state of one request
    PostgresFencedEffectRepository, // a protected write once per step or business key
    PostgresMeshRequestRepository, // a mesh request retried on another pod runs once
    PostgresOutboundCallRepository, // OutboundCalls: intents, reconciled on any pod
    PostgresPausedExecutionRepository, // a pause answered on any pod
    PostgresRateLimitRepository, // a provider's limits, 429 pauses and breakers across pods
  ],
})
export class DeskApplication {}
```

- **The environment.** `PostgresConnection` declares the fields it reads
  (`@Injectable({ environmentFields })`, #511), so a contract without `postgresUrl` fails the
  application's assembly with `[environment.missing-field] … needs postgresUrl: Secret in
  AppEnvironment (read by PostgresConnection)` before anything connects; a value of the wrong kind
  (a plain string for the URL, a pool size of 0) fails the start with `PostgresSettingsError`,
  naming the field, never the URL. `PostgresConnection` itself need not be listed — the container
  creates it for the stores that inject it (#526 AC8); list it only when a component of yours
  injects it.
- **One pool per instance.** Every store injects `PostgresConnection`: one `pg.Pool` per application
  instance, opened at `onInit`, ended at `onDestroy` after its stores; every store's `ping()` is one
  `SELECT 1` (`app.checkReadiness()`).
- **The schema.** The tables go to the first existing schema of the connection's `search_path`
  (`public` by default); `?options=-c%20search_path%3Dmy_schema` in the URL picks another — two
  applications on one database each take their own.
- **A subclass** goes through public tokens only, with the store's own `deps`
  (`[PostgresConnection, StoreClock, ApplicationContext]`), as with the SQLite stores
  ([Several-instances](Several-instances#extending-a-sqlite-implementation)).

## One backend for the fencing stores

A fenced effect and an outbound call check the tree's lease **in their own transaction** (Wiki →
ADR-0026-Fenced-effects-check-the-lease-in-the-same-transaction), so the lease row and the effect's
rows must be in one database. `PostgresExecutionLeaseRepository`, `PostgresFencedEffectRepository`
and `PostgresOutboundCallRepository` declare `static backend = "postgres"` (#526), and assembly
compares each listed fencing store's backend with the lease store's:

| Listed                                                              | At assembly                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| the three PostgreSQL stores                                         | assembles                                                       |
| PostgreSQL leases with the in-memory or SQLite fenced effects/calls | `[application.store-backend-mismatch]`, both stores named       |
| PostgreSQL fenced effects/calls with any other lease store          | `[application.store-backend-mismatch]`, the hint names the lease store of `"postgres"` |
| two lease stores, or two stores of one fencing contract             | `[di.ambiguous-implementation]` (#539)                          |

A subclass inherits `"postgres"`. Fencing stores on a second database declare `"postgres:<database>"`
— all three, the same text. The child queue, the lease log, rate limits and the other stores are not
constrained, though nothing is gained by splitting them.

## Migrations

The schema is versioned SQL files shipped in the package (`migrations/NNNN_<name>.sql`) plus
LangGraph's checkpoint tables (`PostgresSaver.setup()`), never created implicitly:

- **A command**, before the new version of the application starts — a Kubernetes Job (a Helm
  `pre-upgrade` hook, an Argo CD `PreSync` hook) or a pipeline step:

  ```sh
  npx agboss-postgres migrate --url "$DATABASE_URL"   # or DATABASE_URL alone
  ```

  Exit codes: `0` done (a second run prints `nothing to apply`), `1` the migration failed (the
  reason on stderr), `2` a usage error.
- **Or in code**: `await migratePostgres({ url, signal })` → `{ schema, applied, version,
  checkpointMigrations }`.
- **Or at start** with `postgresMigrateOnStart: true` — for a single instance or a development
  database.

Every run takes one advisory lock per schema (`pg_advisory_lock`, a session lock), so concurrent
runs serialize; each file runs in its own transaction; `agboss_schema_migrations` records each with
its checksum, and a file that changed after it ran fails the run (`PostgresMigrationChangedError`). A
schema change is always a new file. At start `PostgresConnection` compares the database with the
package: missing or older migrations are `PostgresSchemaMissingError` (naming the command and the
flag) unless the flag migrates them; a database **newer** than the package — a rolled-back
application — is `PostgresSchemaTooNewError` with or without the flag: migrations are never rolled
back, so roll the application forward, or run the newer image.

## Connections and their limits

- **Count them.** Each instance opens at most `postgresPoolSize` connections (default 10); the
  migration command two (the lock's session and LangGraph's setup). Pods × `postgresPoolSize`, plus a
  migration Job during a rollout, plus everything else on the server, must stay under its
  `max_connections` (100 by default) — a pod that cannot connect fails its operations, and the
  framework's hand-over rules apply.
- **A pool of one never deadlocks** — every transaction runs on the one connection it took — but a
  small pool queues: `pg` waits for a free connection without a timeout, and a lease renewal waits
  behind the work in flight. A holder whose renewal is late is safe — it trusts its lease only until
  `confirmedUntil` and then hands the tree over ([Several-instances](Several-instances#the-execution-lease))
  — but a pool too small for `maxConcurrentSteps` makes hand-overs out of healthy pods. Size it to
  the steps an instance runs at once, plus a few.
- **A fenced effect's `work` holds a connection and the tree's lease row.** It runs inside the
  store's transaction, after `SELECT … FOR UPDATE` of the lease row, and gets the transaction's
  `PoolClient`: everything it awaits holds that connection and that row lock, and the tree's own
  renewal waits for it. Keep `work` to the business rows of that transaction; a call to another
  system belongs in `OutboundCalls.send`, which holds no transaction while it sends.
- **Poolers.** The migration command needs a session of its own (a session advisory lock): run it
  against the server, not through a transaction-mode pooler (PgBouncer `pool_mode = transaction`).
  The stores themselves run every atomic operation as one statement or one transaction and lock only
  with row locks and `pg_advisory_xact_lock`, which end with the transaction; they are tested against
  PostgreSQL directly, never behind a pooler.
- **A lost connection** rejects the operation in flight; the pool drops the connection and opens a
  new one for the next. Nothing retries a write silently: the core's rules decide — a failed renewal
  past `confirmedUntil` aborts the execution's signal and hands the tree over, so a pod never moves a
  tree whose lease it could not renew.

## What the guarantees assume of PostgreSQL

[Guarantees](Guarantees) lists every assumption; on PostgreSQL they read:

- **The database's clock decides a lease (#533).** Every statement that takes, renews, yields,
  reclaims, fences a write under or closes a lease reads `clock_timestamp()` inside itself — the
  server's wall clock at that statement, not `now()` (the transaction's start, which a statement
  that waited on a row lock would see in the past); a statement that decides on a row another
  transaction may hold reads it after its own `SELECT … FOR UPDATE` of that row. So the pods' wall
  clocks may disagree by any amount (tested at ± lease/2, ± lease, ± 10 × lease: agbossjs/postgres
  `tests/processes/clock-skew.test.ts`, `tests/stores/clock-authority.test.ts`): the store answers
  how long a lease has left, and each holder counts that down on its own monotonic clock, minus a
  1 s margin.
- **One clock, slewed** (A3). The database's clock is the primary server's. It must be slewed by
  NTP, never stepped: a forward step ends every live lease early by its size. A failover to a
  replica or a new primary whose clock differs is such a step — keep the servers on one NTP source.
- **Drift** (A4). The holder's clock and the server's together drift less than 1 s per 30 s lease
  (3.3 %; a healthy quartz clock drifts 0.005 %).
- **`READ COMMITTED`.** Every operation runs at PostgreSQL's default isolation; each store states
  its locking in its doc comment. A server whose `default_transaction_isolation` is changed is not
  tested.
- **Business rows in the same database** (A11). A fenced effect's work writes its rows on the
  transaction's own connection; a row written to another database is outside it.
- **Tests move time without the database.** Under `testWith` and the contract suites the stores
  take the test's clock as a parameter (`COALESCE($n::timestamptz, clock_timestamp())`, the
  parameter `null` in production), so the interleaving explorer explores the SQL, not database time;
  database time is what the process tests and the fault suite run on.

## How the stores are proved

agbossjs/postgres's CI runs, on PostgreSQL 16, on every pull request, every push to `main` and nightly:

- **`storeConformance`** (#481, #526, `@agboss/core/testing/contracts`) in one call over the 13
  stores — every published contract suite as `<contract> (PostgreSQL)`, two instances with two
  pools; `store set (PostgreSQL)` (the three fencing stores declare one backend, the leases their
  own contracts ran on); and `interleavings (PostgreSQL)`, the explorer of #533, every schedule of
  two instances four steps deep and 50 seeded walks of three. Nothing is left out (`without`); a
  broken lease store fails it (`tests/contracts/explorer-bites.test.ts`).
- **`faultSuite`** (#484, `@agboss/core/testing/faults`) on the full store set: the core's fixture
  application in real `node` pods on one database, each through a TCP proxy of its own, killed,
  stopped, frozen and cut off it in all of the core's scenarios, every invariant checked after each
  ([Guarantees-across-processes](Guarantees-across-processes)). It runs on the real clock — the
  database decides a lease's expiry at its own rate, so a faster pod clock would test another lease
  than the core's (#607) — split over three parallel jobs.
- **Two-process tests** of each acceptance criterion: a pod killed mid-step and its tree taken
  over, `AnyInstance` children claimed once, a pause answered on the other pod, a shared budget and
  rate limit, the history export, mesh deduplication, and a payment whose pod froze mid-charge
  reconciled, never sent twice.
- **Migrations**: a second run changes nothing (a schema dump compared), concurrent runs serialize, a
  changed file fails, and a database too old or too new fails the start.

A store of your own on another database follows the same path: [Your-own-store](Your-own-store).
