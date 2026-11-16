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
import { hours } from "@agboss/core/units";
import {
  PostgresCheckpointSaver,
  PostgresChildExecutionQueueRepository,
  PostgresCostLedgerRepository,
  PostgresExecutionHistoryRepository,
  PostgresExecutionAuditLogRepository,
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
  retention: { executionRecords: hours(24 * 30) }, // 30 days
  retention: { costLedgerEntries: hours(24) }, // the ledger's entries (#771): the default, pruned by the sweep
  providers: [
    PostgresCheckpointSaver, // LangGraph's PostgresSaver on the shared pool
    PostgresChildExecutionQueueRepository, // ChildPlacement.AnyInstance children
    PostgresCostLedgerRepository, // budgets count every pod's spend
    PostgresExecutionHistoryRepository, // agboss records export on any pod
    PostgresExecutionAuditLogRepository, // the audit log: app.auditLogOf
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
- **A2A tasks** (#824): an application that serves A2A (`@A2AExpose`) also lists
  `PostgresA2ATaskRepository` (migration `0026_a2a_tasks`): the same `messageId` sent to two pods
  at once starts one execution, and `GetTask` / `ListTasks` read any pod's tasks. Without it the
  application does not assemble (`[a2a.task-store-not-shared]`, [A2A](A2A)).
- **A subclass** goes through public tokens only, with the store's own `deps`
  (`[PostgresConnection, StoreClock, ApplicationContext]`), as with the SQLite stores
  ([Several-instances](Several-instances#extending-a-sqlite-implementation)).

## One backend for the fencing stores

A fenced effect and an outbound call check the tree's lease **in their own transaction** (Wiki →
ADR-0026-Fenced-effects-check-the-lease-in-the-same-transaction), so the lease row and the effect's
rows must be in one database. `PostgresExecutionLeaseRepository`, `PostgresFencedEffectRepository`
and `PostgresOutboundCallRepository` declare `static store = { backend: "postgres" }` (#526, #825), and assembly
compares each listed fencing store's backend with the lease store's:

| Listed                                                              | At assembly                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| the three PostgreSQL stores                                         | assembles                                                       |
| PostgreSQL leases with the in-memory or SQLite fenced effects/calls | `[application.store-backend-mismatch]`, both stores named       |
| PostgreSQL fenced effects/calls with any other lease store          | `[application.store-backend-mismatch]`, the hint names the lease store of `"postgres"` |
| two lease stores, or two stores of one fencing contract             | `[di.ambiguous-implementation]` (#539)                          |

A subclass inherits `"postgres"`. Fencing stores on a second database declare `"postgres:<database>"`
— all three, the same text. The child queue, the audit log, rate limits and the other stores are not
constrained, though nothing is gained by splitting them.

## Migrations

The schema is versioned SQL files shipped in the package (`migrations/NNNN_<name>.sql`) plus
LangGraph's checkpoint tables (`PostgresSaver.setup()`), never created implicitly:

- **A command**, after the old version is stopped and before the new one starts — a Kubernetes Job
  or a pipeline step. **An upgrade that changes the schema is stop → migrate → deploy**, never a
  rolling one ([ADR-0034](ADR-0034-Schema-upgrades-stop-the-old-version-first)): scale the old
  Deployment to zero, run the Job, deploy the new version. A Helm `pre-upgrade` hook or an Argo CD
  `PreSync` Job runs while the old pods still serve, so it fits only an upgrade that changes no schema
  (`migrate` prints `nothing to apply`); see [Deploying on Kubernetes](Deploying-on-Kubernetes#upgrading-across-a-schema-change).
  An old pod that is still running after the migration writes in the old shape (a pause without its
  channel, no notice, a lease under a renamed column), and an idle one holds no lease, so no check can
  see it: stopping it is yours.

  ```sh
  npx agboss-postgres migrate --url "$DATABASE_URL"   # or DATABASE_URL alone
  ```

  Exit codes: `0` done (a second run prints `nothing to apply`), `1` the run failed, `2` a usage
  error. Exit `1` means either "the migration failed" (stderr: `agboss-postgres: the migration failed
  — <reason>`) or "the migrations are applied, only the index step failed" (stdout lists what was
  applied, stderr is one `index checkpoints_latest_by_step (<schema>) failed: …` line). Its last
  stdout line says what it did to the checkpoint index; the failure and how to tell the two apart
  are [below](#the-checkpoint-index-962).
- **Or in code**: `await migratePostgres({ url, signal })` → `{ schema, applied, version,
  checkpointMigrations, stepIndex }`.
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

## The checkpoint index (#962)

`PostgresCheckpointSaver.latestByStep` reads a marked thread's newest checkpoint by LangGraph's step
in one index walk ([Your own store](Your-own-store#the-checkpoint-savers-optional-latestbystep-962)).
The index, `checkpoints_latest_by_step`, is not a numbered migration: `checkpoints` is made by
LangGraph's setup, after the numbered files, so every `migrate` run builds it as a **step of its
own** after them:

- **`CREATE INDEX CONCURRENTLY`**, on a session of its own outside any transaction: a populated
  table keeps taking checkpoint writes while it builds (1 000 000 rows: a 1.5 s build, no write held
  longer than 90 ms). It waits for the transactions open in the database when it starts, so a long
  application transaction delays the build, never the writes.
- **One builder at a time.** A session-level `pg_try_advisory_lock` that never waits: a run that does
  not get it (another is building) skips the step and goes on.
- **A start that migrates does not wait for it** (`postgresMigrateOnStart`): the pod serves while
  the index builds. `agboss-postgres migrate` and `migratePostgres` return when it is done.
- **Reads are correct without it**, only slower (10 000 checkpoints: 38 ms listing and sorting, 1.7 ms
  with the index). A skipped or failed build costs speed until the next run builds it.
- **An INVALID leftover** (a build that crashed) is dropped (`DROP INDEX CONCURRENTLY`) and built
  again by the next run that holds the lock. The drop waits at most 3 s (`lock_timeout`, [see
  below](#when-the-index-step-fails-exit-1)): it never holds the run for another transaction.

The command's last line says which it was:

```text
built index checkpoints_latest_by_step (public)
index checkpoints_latest_by_step (public) is ready
skipped index checkpoints_latest_by_step (public): another run holds its build lock; run migrate again when it ends
```

`built`: this run made it. `is ready`: it was there and valid. `skipped`: another run holds the
build's lock, so this one did nothing to the index — run `migrate` again when that one ends. The same
is `MigrationReport.stepIndex` (`"built"`, `"present"`, `"skipped"`; unset for a start that
migrates). To check by hand, `\d <schema>.checkpoints` lists `checkpoints_latest_by_step`; an INVALID
index is marked so there.

### When the index step fails (exit 1)

The numbered migrations commit before the index step runs. When only the index step fails, the schema
**is** migrated and every read answers correctly (`latestByStep` slower), but the command still exits
`1`. So exit `1` has two readings, and the output tells them apart:

| Exit `1` with | Schema | What to do |
| --- | --- | --- |
| stderr `agboss-postgres: the migration failed — <reason>` | not fully migrated | fix the reason, run `migrate` again |
| stdout the `applied …` (or `nothing to apply …`) lines and no index line; stderr one `index checkpoints_latest_by_step (<schema>) failed: …` line | migrated | deploy; run `migrate` again for the index |

The index line, in full:

```text
index checkpoints_latest_by_step (public) failed: <cause>; the migrations are applied and reads stay correct; the next migrate run rebuilds the index (an INVALID one is dropped first)
```

`<cause>` is why the build failed: it was cancelled, or the role does not own `checkpoints`. The failed
build's own INVALID leftover is dropped on the spot.

**The drop is bounded (3 s).** `DROP INDEX CONCURRENTLY` waits for every transaction that holds a
lock on `checkpoints`, an idle one included. The drop of an INVALID index (at the start of a run, and
after a failed build) therefore gives up after 3 s (`lock_timeout`) instead of holding the run. The run
then exits `1` with the INVALID-stays variant:

```text
index checkpoints_latest_by_step (public) failed: canceling statement due to lock timeout; the migrations are applied and reads stay correct; an INVALID index checkpoints_latest_by_step stays: the next migrate run drops and rebuilds it
```

A transaction left idle on `checkpoints` (a reader that ran `SELECT 1 FROM checkpoints` and neither
committed nor rolled back, or an idle writer) makes every following run fail like that until it ends
(about 3.4 s per run). The operator finds it, ends it (or fixes the client that leaks it), and runs
`migrate` again, which drops the leftover and builds the index:

```sql
SELECT pid, state, xact_start, query FROM pg_stat_activity WHERE state LIKE 'idle in transaction%';
SELECT pg_terminate_backend(<pid>);
```

**In code**, `migratePostgres` throws `PostgresStepIndexError` (`code` `postgres.step-index-failed`)
when only the index step failed; any other error means the migration did not run to its end. Its
`report` is the `MigrationReport` of what the run committed (`applied`, `version`,
`checkpointMigrations`), `invalidIndexLeft` is `true` when an INVALID index stays for the next run to
drop, and `cause` is why the step failed. A script that catches it deploys; one that catches anything
else stops.

## Connections and their limits

(The platform's side — pods, grace, probes, the autoscaler's maximum: [Deploying on Kubernetes](Deploying-on-Kubernetes).)

- **Count them.** Each instance opens at most `postgresPoolSize` connections (default 10); the
  migration command two (the lock's session and LangGraph's setup). Pods × `postgresPoolSize`, plus a
  migration Job during a rollout, plus everything else on the server, must stay under its
  `max_connections` (100 by default) — a pod that cannot connect fails its operations, and the
  framework's hand-over rules apply.
- **A pool of one never deadlocks** — every transaction runs on the one connection it took — but a
  small pool queues: `pg` waits for a free connection without a timeout, and a lease renewal waits
  behind the work in flight. A holder whose renewal is late is safe — it trusts its lease only until
  `trustedUntil` and then hands the tree over ([Several-instances](Several-instances#the-execution-lease))
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
  past `trustedUntil` aborts the execution's signal and hands the tree over, so a pod never moves a
  tree whose lease it could not renew.

## The cancel's fence (#909)

Migration `0032_execution_cancel_requests` adds `agboss_execution_cancel_requests` (the cancel's mark
per tree: tenant, root, `requested_at`) — a table of its own, so run
`agboss-postgres migrate` **with no instance of an older version running**, then start the version
that writes it. The fence of [ADR-0030](ADR-0030-A-cancel-is-a-fence) holds only then: an older
instance neither writes the mark nor reads it, so a tree it holds could commit an effect after a
cancel that a newer instance requested. The mark is written
by `PostgresExecutionLeaseRepository.requestCancel` and read by the fenced-effect and outbound-call
stores in their own transactions, each under a pair of advisory locks of the tree's identity
(namespace 909, beside the business key's 508): the cancel takes the exclusive one, so it waits for
the tree's open fencing transactions; a fencing transaction takes the shared one after its lease and
key checks and reads the committed mark. A long fenced `work` therefore delays a cancel of its tree,
never the other way round.

A mark is **permanent** (#1117, [Guarantees](Guarantees) A18): no retention pass lifts it, not by age
and not once the tree's lease is retired, because a still-live lease of a child of the cancelled tree
would then write after the cancel. It is kept as the lease rows and the execution ids are, one per
cancelled tree, never scanned, so size it as one row per cancelled tree.

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

## When a COMMIT's outcome is unknown (#1017)

A COMMIT, or a single write outside a transaction, is classified by whitelist. It is a definite failure (the error as it is; the step fails, its undo may run) only when the error proves nothing was applied:

- pg never sent it: "Client has encountered a connection error and is not queryable", "Client was closed and is not queryable";
- the server answered that it aborted it (an ErrorResponse of class 09, 21, 22, 23, 25, 2F, 38, 40 but 40003, 42, 44, P0 — e.g. 23505 of a deferred constraint at COMMIT, 40001, 40P01, 25P02).

Everything else is `StoreOutcomeUnknownError` (source `transport`): every other SQLSTATE (08007, 08P01, XX000, 53100, 53200, 57P01, 58030, …), a socket, TLS or stream error, pg's framing errors, an error without a code. Under a lease the holder then hands the tree over and the next holder reconciles. A command timeout (57014, "Query read timeout") is `StoreCallTimeoutError`. A statement inside a transaction before its COMMIT, and a read, are never unknown: the transaction rolls back.

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
  than the core's (#607) — split over three parallel jobs (`shard: "env"`, `AGBOSS_FAULT_SHARD`,
  #831), its sabotages included.
- **Two-process tests** of each acceptance criterion: a pod killed mid-step and its tree taken
  over, `AnyInstance` children claimed once, a pause answered on the other pod, a shared budget and
  rate limit, the history export, mesh deduplication, and a payment whose pod froze mid-charge
  reconciled, never sent twice.
- **Migrations**: a second run changes nothing (a schema dump compared), concurrent runs serialize, a
  changed file fails, and a database too old or too new fails the start.

A store of your own on another database follows the same path: [Your-own-store](Your-own-store).
