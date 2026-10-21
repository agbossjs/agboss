# Several instances

An application may run as several instances (processes, machines) over shared stores: any instance
continues an execution another one paused, and two instances never move one execution tree at the
same time. This page says what is shared, how a tree is moved by one instance at a time (its
**lease**), and how to test it (#265).

## What is shared — the stores to replace

Every store is an [infrastructure contract](App#infrastructure) with a built-in **in-memory**
default, listed only in `@Application({ providers })` and found by inheritance. In memory nothing
is shared between instances and nothing survives a restart, so with more than one instance list a
shared implementation of each:

| Contract                    | Shared because                                                                  |
| --------------------------- | ------------------------------------------------------------------------------- |
| `BaseCheckpointSaver`       | a pause made on one instance is resumed on another                              |
| `PausedExecutionRepository` | the same; a pause goes `Pending → Resolved` once, whichever instance answers it |
| `ExecutionRecordRepository` | threads, owners and records are the application's, not an instance's           |
| `CostLedgerRepository`      | budgets count the spend of every instance                                       |
| `ExecutionLeaseRepository`  | one holder per execution tree (below)                                           |
| `ExecutionTreeRepository`   | the shared state of one request, read by its executions on any instance         |
| `RateLimitRepository`       | a model provider's limit, its 429 pause and its circuit breaker hold on every instance (#266) |

Each contract has a ready **SQLite** implementation (#265 PR 3), or a project lists its own
(`extends` the contract, `@Injectable({ deps })`, [below](#your-own-implementation)).

## SQLite — several instances on one machine

| Contract                    | SQLite implementation             | Tables                            |
| --------------------------- | --------------------------------- | --------------------------------- |
| `BaseCheckpointSaver`       | `SqliteCheckpointSaver`           | `checkpoints`, `checkpoint_writes` |
| `PausedExecutionRepository` | `SqlitePausedExecutionRepository` | `paused_executions`               |
| `ExecutionRecordRepository` | `SqliteExecutionRecordRepository` | the Tern tables (`threads`, `terns`, …) |
| `CostLedgerRepository`      | `SqliteCostLedgerRepository`      | `cost_ledger`, `cost_ledger_max_spend` |
| `ExecutionLeaseRepository`  | `SqliteExecutionLeaseRepository`  | `execution_leases`                |
| `ExecutionTreeRepository`   | `SqliteExecutionTreeRepository`   | `execution_tree_keys`             |
| `RateLimitRepository`       | `SqliteRateLimitRepository`       | `rate_limit_slots`, `rate_limit_window_entries`, `rate_limit_pauses` |

Every row carries the tenant (#261): the threads and the records `tenant_id`, `paused_executions`
is keyed by `(tenant_id, thread_id)`, a checkpoint and its writes are tagged with the run's tenant,
the leases and tree keys are keyed by it; a file written before tenants is migrated on first use,
its rows in the tenant `"default"`.

Each one is enabled only by listing it in `@Application({ providers })` — list one, some or all; a
contract not listed keeps its in-memory default. They are built on `node:sqlite` (no native
driver to install; `SqliteCheckpointSaver` is our own `BaseCheckpointSaver`, serializing with
LangGraph's `serde`) and share **one file**: the environment contract's `sqlitePath`, required only
when a SQLite implementation is listed — a contract without it fails assembly with
`[environment.missing-field] SqliteExecutionLeaseRepository needs sqlitePath: string in
AppEnvironment` ([Environments](Environments)), an empty value fails the start naming it.

<!-- snippet-context
import { Application, EmptyEnvironment, SqliteCheckpointSaver, SqliteCostLedgerRepository, SqliteExecutionLeaseRepository, SqliteExecutionRecordRepository, SqliteExecutionTreeRepository, SqlitePausedExecutionRepository, SqliteRateLimitRepository, env } from "agboss";
-->

```ts
// environments/app.environment.ts — the contract
export class AppEnvironment {
  sqlitePath!: string; // required because SQLite implementations are listed
}

// environments/prod.environment.ts — one file per machine; tests: sqlitePath: ":memory:"
export const environment: AppEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_PATH"),
};

// job-scout.application.ts: @Application({ …, environment: AppEnvironment, providers: sqliteStores })
export const sqliteStores = [
  SqliteExecutionRecordRepository,
  SqliteCostLedgerRepository,
  SqlitePausedExecutionRepository,
  SqliteCheckpointSaver,
  SqliteExecutionLeaseRepository,
  SqliteExecutionTreeRepository,
  SqliteRateLimitRepository,
];
```

- **One connection per application instance**, shared by its SQLite stores and opened when the
  first one is created; two instances (two processes, or `testWith(App, { instances: 2 })`) open
  two connections to one file. The file is in WAL mode (readers never block the writer) with a
  `busy_timeout` of 5 s (a writer waits for the other's lock, then fails — it never hangs); the
  connection is closed in `onDestroy` when the instance stops. `SqliteConnection` is the DI token
  of that connection (a subclass names it in its `deps`, [below](#extending-a-sqlite-implementation));
  the container creates it — project code never constructs it.
- **Atomic operations** — a lease `acquire`, a slot `acquire`, `saveIfAbsent`, a pause
  `Pending → Resolved`, a ledger counter — run in one `BEGIN IMMEDIATE` transaction, so of two
  instances exactly one wins; `renew` / `release` and the records' compare-and-set write are one
  statement each.
- **Time comes from the application's `Clock`** (#262, [Testing → The clock](Testing#the-clock)),
  never from SQLite (`expiresAt`, the ledger's UTC day are parameters), so `clock.advance(…)` moves
  SQLite leases in tests like in-memory ones.
- `node:sqlite` is synchronous: a transaction is one group of statements with no `await`, and a
  busy wait blocks that instance's event loop for at most the busy timeout.
- With them, what one process wrote is there for the next: `agboss run` / `chat --thread <id>`
  continue a thread after a restart, `agboss eval` / `replay` / `golden` read the records of
  earlier runs (a workflow run on its own uses the infrastructure its application lists), a pause
  is resumed after a restart, and another instance on the file recovers a run whose process
  died ([Recovery](#recovery)). job-scout lists all seven (`sqlitePath` in dev:
  `.agboss/job-scout.sqlite`, or `AGBOSS_SQLITE_PATH`).

### Extending a SQLite implementation

A SQLite implementation is a class like any other: a project `extends` it, `override`s what it
changes and lists the subclass **instead of** it (both listed → `[di.ambiguous-implementation]`).
The subclass takes the base class's dependencies first — every one a public token (#265 S70):
`SqliteConnection`, the application's `Clock`, for the leases, the rate-limit slots and the records
the `ApplicationContext` (its `instanceId` is the holder of what this instance takes), and for the
records the application's `IdGenerator` (#313: a new thread's id):

| Implementation | Its `deps` |
| --- | --- |
| `SqliteCheckpointSaver`, `SqliteExecutionTreeRepository`, `SqliteCostLedgerRepository` (#261 PR 5: each counter's period is named by the runtime from the `Clock`) | `[SqliteConnection]` |
| `SqlitePausedExecutionRepository` | `[SqliteConnection, Clock]` |
| `SqliteExecutionLeaseRepository`, `SqliteRateLimitRepository` | `[SqliteConnection, Clock, ApplicationContext]` |
| `SqliteExecutionRecordRepository` | `[SqliteConnection, Clock, ApplicationContext, IdGenerator]` |

<!-- snippet-context
import type { ExecutionLease } from "agboss";
@Injectable()
export class LeaseAuditService {
  taken(_lease: ExecutionLease): void {}
}
-->

```ts
import {
  ApplicationContext,
  Clock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
} from "agboss";
import type { Milliseconds } from "agboss/units";

/** The SQLite leases, each one taken written to the audit log as well. */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, LeaseAuditService] })
export class AuditedSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  constructor(
    connection: SqliteConnection,
    clock: Clock,
    applicationContext: ApplicationContext,
    private readonly leaseAuditService: LeaseAuditService,
  ) {
    super(connection, clock, applicationContext);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const taken = await super.acquire(tenantId, rootExecutionId, lease);
    if (taken !== undefined) this.leaseAuditService.taken(taken);
    return taken;
  }
}
```

The subclass still needs `sqlitePath` (`[environment.missing-field]` names it) and shares the
instance's one connection. The records the same way (#313) — a new thread's id comes from the
`IdGenerator` it passes on ([App → Infrastructure](App#infrastructure)):

<!-- snippet-context
@Injectable()
export class ThreadAuditService {
  created(_threadId: string): void {}
}
-->

```ts
import {
  ApplicationContext,
  Clock,
  IdGenerator,
  Injectable,
  SqliteConnection,
  SqliteExecutionRecordRepository,
  type NewThread,
} from "agboss";

/** The SQLite records, each new thread written to the audit log as well. */
@Injectable({
  deps: [SqliteConnection, Clock, ApplicationContext, IdGenerator, ThreadAuditService],
})
export class AuditedSqliteExecutionRecordRepository extends SqliteExecutionRecordRepository {
  constructor(
    connection: SqliteConnection,
    clock: Clock,
    applicationContext: ApplicationContext,
    idGenerator: IdGenerator,
    private readonly threadAuditService: ThreadAuditService,
  ) {
    super(connection, clock, applicationContext, idGenerator);
  }

  override async createThread(thread: NewThread): Promise<string> {
    const threadId = await super.createThread(thread);
    this.threadAuditService.created(threadId);
    return threadId;
  }
}
```

## The execution lease

One lease per execution tree, keyed by `(tenantId, rootExecutionId)` — the execution's tenant
(#261, `"default"` when it names none); the holder's `holderInstanceId` is its instance's
`ApplicationContext.instanceId`. Whoever moves the tree holds it: `app.execute` from its first step,
`app.resume` once it has recorded its decision. The holder:

- renews the lease in the background every 10 seconds (a third of its fixed length, `seconds(30)` —
  not a setting) and right before every checkpoint write;
- releases it when its pass ends — the tree paused, finished or failed. A paused or finished tree
  holds no lease;
- when a renewal answers `false` (the lease expired — the instance was frozen or cut off for longer
  than 30 seconds — and another instance took it, `leaseEpoch + 1`), stops: its work is aborted
  through its signal and its call rejects with `ExecutionLeaseLostError` (`execution.lease-lost`).
  That is not a failure of the execution: it reaches neither `.onError`, `onExecutionError` nor the execution
  record — the new holder owns the execution and continues it.

**Two resumes at once.** A resume has two phases: it first records its decision on its pause (the
pause goes `Pending → Resolved` atomically — a second resume of the same pause, a double click,
gets `NotPausedError`), then takes the tree's lease. While another call or instance holds it, the
resume waits; the holder continues with one `Command({ resume })` that maps LangGraph's interrupt
id of every answered pause of the tree, and before it lets the tree rest paused takes the decisions
resolved meanwhile (the drain), so the waiting call then returns the tree's current
`ExecutionOutput`, its decision taken. Two pauses of parallel branches answered at once on two
instances are both taken, each step once ([Pauses](Pauses#concurrent-answers)). If the holder's
lease expires while a call waits, the waiting call takes it and goes on.

**Documented limit.** The renewal before a checkpoint write and the write are two round trips to the
stores, not one atomic operation (`BaseCheckpointSaver` is taken as is, so ecosystem savers plug
in): the race window is one round trip.

## Recovery

An execution whose instance died mid-step is continued by another instance, automatically (#265
S30). The record of a root is `ExecutionRecordStatus.Running` while its tree moves (a resume makes
it `running` again once it has recorded its decision). Every instance, at its start and then every
30 seconds (the lease length, through the framework's clock):

1. lists the `running` records (`ExecutionRecordRepository.findByStatus(ExecutionRecordStatus.Running,
   limit, after)`, page by page);
2. tries each one's lease: a live holder renews it, so only a tree whose holder **died** (its lease
   expired) or **stopped** (released it) is taken, with `leaseEpoch + 1`; of two instances sweeping
   at once one gets it;
3. continues the tree from its **last checkpoint**, taking a decision a resume recorded meanwhile
   first (a `Resolved` pause). Every step that finished keeps its writes — every step is
   checkpointed before the next one starts — so **only the interrupted step runs again**; a
   side-effecting tool keeps its effect once through `executionContext.step.idempotencyKey`;
4. checks compatibility as `app.resume` does: a root started under another config hash is not
   continued unless the workflow's `onIncompatibleResume` says `"resume"` — it is left to an
   instance of a compatible version (a rolling deploy) and logged once.

Each recovery is logged (`execution.recovered`, a warning in the application's
[log](Observability#the-frameworks-log) with its `executionId` and `tenantId`; a root left to a
compatible instance is `recovery.incompatible`, a failed one `recovery.failed`) and traced, and
observers get `onExecutionResume` with `reason: ResumeReason.Recovered` (`decision` when it took a
recorded one), then `onExecutionEnd` / `onExecutionPause` / `onExecutionError` as for any pass.

<!-- snippet-context
import { Injectable, ResumeReason, type OnExecutionResume, type ExecutionResumeEvent } from "agboss";
-->

```ts
@Injectable()
export class RecoveryCounter implements OnExecutionResume {
  onExecutionResume(event: ExecutionResumeEvent): void {
    if (event.reason === ResumeReason.Recovered) {
      // an instance died or stopped while this run moved: count it, alert
    }
  }
}
```

**The same sweep keeps the pause records small** (#267 S107): at each look it removes, across
tenants, the resolved pause records (`Taken`, `Cancelled`) resolved more than
`@Application({ pauseRecordRetention })` ago — default `hours(24)` —
through `PausedExecutionRepository.deleteResolvedBefore(cutoff)`, `cutoff` = the `Clock`'s now minus
the retention. Every instance may run it; it is idempotent. Within the window a late answer to a
taken or withdrawn pause gets `NotPausedError`, after it `UnknownPauseError`; a `Pending` pause is
never removed ([Pauses → a pause's life](Pauses#a-pauses-life)). A project's own
`PausedExecutionRepository` implements `deleteResolvedBefore` too — one statement over the records'
status and `resolvedAt` (`SqlitePausedExecutionRepository`: an index on `(status, resolved_at)`). Who
answered each pause is not in these records: it is written into the execution records when the
pause is resolved (`ExecutionRecordRepository.savePauseAnswer`), so the sweep never changes
`result.record.pauses`.

A free-text reply (`app.resume({ pauseId, reply })`, #267 PR 3) is read on the instance that got
the call, before the pause is resolved and before the tree's lease is taken: the interpreter's
model call holds no lease, and its spend reaches the tree's budgets through the shared ledger at
once, whichever instance then moves the tree.

**A graceful stop** (`app.close()`, SIGTERM — [App → app.close()](App#appcloseoptions)) first stops
the instance's own sweep, waits for its running executions up to the shutdown timeout (default
`seconds(25)`), then interrupts what is left: each releases its lease at once and stays `running`,
so another instance takes it at its next sweep, without waiting for the lease to expire.

## The shared state of one request

`ExecutionTreeRepository` keeps keys under the request's root execution: visible to the whole tree
of executions at any depth and on any instance, invisible to other requests, removed when the tree
finishes, fails or is cancelled (a pause keeps them). `saveIfAbsent` is atomic — of two branches
claiming one key exactly one gets `true`. Keys come from identifiers in DTOs, never from text:

<!-- snippet-context
import { Text } from "agboss/dto";
export class SubtopicDto {
  @Text({ prompt: "the subtopic's id" })
  subtopicId!: string;
}
export class SubtopicClaimDto {
  @Text({ prompt: "who researches it" })
  researcher!: string;
}
-->

```ts
import { ExecutionTreeRepository, Tool, type ToolHandler } from "agboss";

@Tool({
  name: "claim_subtopic",
  description: "Claims a subtopic once per request",
  input: SubtopicDto,
  output: SubtopicClaimDto,
  deps: [ExecutionTreeRepository],
})
export class ClaimSubtopicTool implements ToolHandler<SubtopicDto, SubtopicClaimDto> {
  constructor(private readonly executionTreeRepository: ExecutionTreeRepository) {}

  async run(input: SubtopicDto): Promise<SubtopicClaimDto> {
    const claimed: boolean = await this.executionTreeRepository.saveIfAbsent(
      `subtopic:${input.subtopicId}`, // by identifier, never by normalized text
      true,
    );
    return { researcher: claimed ? "this branch" : "another branch" };
  }
}
```

## Your own implementation

A project's implementation `extends` the contract and is listed in `@Application({ providers })`
(`<Qualifier><Contract>`, e.g. `RedisExecutionLeaseRepository`). Its operations are atomic, and every
time value comes from the framework (`lease` is a duration, `expiresAt` a `Date`; the current time
from the application's `Clock`, `deps: [Clock]`), never from the store's own clock:

<!-- snippet-context
@Injectable()
export class LeaseTableService {
  insertIfFree(_tenantId: string, _rootExecutionId: string, _lease: number): Promise<ExecutionLease | undefined> {
    return Promise.resolve(undefined);
  }
  extendIfHeld(_executionLease: ExecutionLease, _lease: number): Promise<boolean> {
    return Promise.resolve(false);
  }
  deleteIfHeld(_executionLease: ExecutionLease): Promise<void> {
    return Promise.resolve();
  }
}
-->

```ts
import { ExecutionLeaseRepository, Injectable, type ExecutionLease } from "agboss";
import type { Milliseconds } from "agboss/units";

@Injectable({ deps: [LeaseTableService] })
export class TableExecutionLeaseRepository extends ExecutionLeaseRepository {
  constructor(private readonly leaseTableService: LeaseTableService) {
    super();
  }

  override acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    return this.leaseTableService.insertIfFree(tenantId, rootExecutionId, lease);
  }

  override renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    return this.leaseTableService.extendIfHeld(executionLease, lease);
  }

  override release(executionLease: ExecutionLease): Promise<void> {
    return this.leaseTableService.deleteIfHeld(executionLease);
  }
}
```

## Testing several instances

`testWith(App, { instances: 2 })` runs two application instances in one test — `apps[0]` (= `app`)
and `apps[1]`, each with its own container and instance id — over one set of stores and one clock
(`clock`, shared). With the in-memory defaults the instances share their rows, so the framework's
own implementations are tested across instances; nothing is substituted, so an application that
lists its own implementations is tested on those (against Testcontainers, or with its injected
client replaced by `mockOf(…)`).

```ts no-check: the application and its workflow are a project's own (see Testing)
const test = testWith(LeaseApplication, { instances: 2 });

test("a pause made on one instance is resumed on the other", async ({ app, apps, mockLlm }) => {
  mockLlm(ClerkAgent).thenReturn(callTool(ChargeTool, { amount: "10" }), replyWith("Charged."));
  const paused = await app.execute(OrderWorkflowStart, { text: "charge" });

  const pauseId = paused.pending[0]?.pauseId ?? ""; // a ThreadOwner pause lists its id
  const resumed = await apps[1].resume({ pauseId, decision: { approved: true } });

  expect(resumed.output).toEqual({ text: "Charged." });
});

test("a holder frozen past the lease loses it", async ({ clock }) => {
  // … one instance moves the tree, the other waits for it …
  await clock.advance(seconds(31)); // the time jumps: the waiting instance takes the lease first
});
```

Recovery is tested the same way: kill one instance (a lease store of the test's own whose
`renew` answers `false` and whose `acquire` gives nothing for that instance — a crashed process, as
the store sees it), `await clock.advance(seconds(31))`, and the other instance's sweep continues the
tree; or `await app.close({ timeout })` with an execution still running, and the other instance
continues it at its next sweep.

`clock` is the test's `VirtualClock` — one for all the instances of the test, the `Clock` every one
of them reads ([Testing → The clock](Testing#the-clock)). `await clock.advance(d)` lets the work
already started reach its next wait, moves the time, then wakes every wait that is due in time
order (lease renewals, a resume waiting for a lease, the recovery sweep) — a jump longer than the
lease is a holder frozen for that long.

## Limits

- With the in-memory defaults nothing is shared between instances and nothing survives a restart:
  run one instance, or list shared stores.
- **SQLite on one file serves one machine**: its locks are local, so instances on several machines
  need a networked store (your own implementation over Postgres, Redis, …). A file on a network
  share is not supported.
- **SQLite in memory is not SQLite on disk**: `sqlitePath: ":memory:"` gives each connection its
  own database — instances do not share it, a restart (`recoverApp()`) starts empty, and there are
  no locks between writers. A test of several instances or of a restart on SQLite uses a
  temporary file.
- With the in-memory defaults nothing survives a restart, so there is nothing to recover:
  recovery works with persistent stores (records, checkpoints, paused executions, leases).
- A stop releases its leases at once, but the other instances notice at their next sweep (within
  30 s); a crashed instance's trees wait for their lease to expire first (up to 30 s more).
- Fairness between tenants waiting for a model provider's slots is per instance (#266): the
  tenant-fair queue is in-process, and between instances a slot goes to whoever takes its lease
  first. So is the AIMD slowdown after a 429 — the pause itself, the hard caps (`maxConcurrentCalls`,
  `perMinute`) and an open circuit breaker are shared through `RateLimitRepository`.

## A model provider's rate limit across instances (#266)

`RateLimitRepository` holds three kinds of state, each atomic across instances:

- **slots** — `acquire(key, maxSlots, lease)` / `renew` / `release`: a provider's
  `maxConcurrentCalls` (`<provider>:slots`), a lease of a minute renewed while a call runs;
- **windows** — `addToWindow(key, amount, window, limit?)` (the new total, `undefined` when it would
  pass `limit`; `amount` 0 reads it) and `clearWindow(key)`: the per-minute calls and tokens, and a
  circuit breaker's failures;
- **pauses** — `pauseUntil(key, until)` (a later pause is kept) and `pausedUntil(key)`: the pause
  after a 429 (`<provider>:cooldown`) and an open breaker (`<provider>:circuit-open`).

`SqliteRateLimitRepository` keeps them in `rate_limit_slots`, `rate_limit_window_entries` and
`rate_limit_pauses`; a file an older version wrote gets the two new tables when it is opened. Your
own implementation (Redis, …) `extends RateLimitRepository` and implements all seven methods; the
shared contract suite of the framework (`tests/infrastructure/rate-limit.contract.test.ts`) is the
behaviour to match.
