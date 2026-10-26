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
| `MeshRequestRepository`     | a trusted mesh request answered once, whichever instance its repeat reaches (#398) |
| `ChildExecutionQueueRepository` | a child launched with `ChildPlacement.AnyInstance` is claimed by one instance, whichever (#333) |

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
| `MeshRequestRepository`     | `SqliteMeshRequestRepository`     | `mesh_requests`                   |
| `ExecutionHistoryRepository` | `SqliteExecutionHistoryRepository` | `execution_history` ([Execution history](Execution-history)) |
| `ChildExecutionQueueRepository` | `SqliteChildExecutionQueueRepository` | `child_execution_queue` ([below](#children-on-any-instance-333)) |

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
import { Application, EmptyEnvironment, SqliteCheckpointSaver, SqliteCostLedgerRepository, SqliteExecutionLeaseRepository, SqliteExecutionRecordRepository, SqliteExecutionTreeRepository, SqlitePausedExecutionRepository, SqliteRateLimitRepository, env } from "@agboss/core";
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
| `SqliteCheckpointSaver`, `SqliteExecutionTreeRepository`, `SqliteMeshRequestRepository`, `SqliteCostLedgerRepository` (#261 PR 5: each counter's period is named by the runtime from the `Clock`) | `[SqliteConnection]` |
| `SqlitePausedExecutionRepository` | `[SqliteConnection, Clock]` |
| `SqliteExecutionLeaseRepository`, `SqliteRateLimitRepository`, `SqliteChildExecutionQueueRepository` | `[SqliteConnection, Clock, ApplicationContext]` |
| `SqliteExecutionRecordRepository` | `[SqliteConnection, Clock, ApplicationContext, IdGenerator]` |

<!-- snippet-context
import type { ExecutionLease } from "@agboss/core";
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
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";

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
} from "@agboss/core";

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
  record — the new holder owns the execution and continues it;
- fences itself locally (#335): it trusts the lease until `confirmedUntil` — the `Clock` read
  before its last acquire or renewal the store confirmed, plus 30 seconds (the store counts from a
  later moment, so its lease never ends earlier). A lease store that errors **before** then is
  tried again at the next renewal, and a checkpoint write goes on. When `confirmedUntil` comes with
  no confirmed renewal — the store unreachable for the whole lease — the holder stops at that
  moment, whether or not another instance took the lease yet: its signal aborts with
  `ExecutionLeaseLostError` (the message says the lease expired before its store confirmed a
  renewal; the class, `code` and fields are the same), an agent's tool loop starts no further model
  or tool call, a checkpoint write at or past it throws it, and the record stays `running` for
  [recovery](#recovery).

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
   instance of a compatible version (a rolling deploy) and logged once. The root's hash covers its
   child workflows, recursively (#336): a deploy that changes only a child — its prompt, model,
   flow or version — makes the roots running or paused inside it incompatible too, though the
   root's own `@Workflow({ version })` is the same.

An instance that caps its steps (`@Application({ maxConcurrentSteps })`, #332) starts at most as
many recoveries per look as it has free step slots, and none while it is full
([An instance's cap on steps](#an-instances-cap-on-steps-332)).

Each recovery is logged (`execution.recovered`, a warning in the application's
[log](Observability#the-frameworks-log) with its `executionId` and `tenantId`; a root left to a
compatible instance is `recovery.incompatible`, a failed one `recovery.failed`) and traced, and
observers get `onExecutionResume` with `reason: ResumeReason.Recovered` (`decision` when it took a
recorded one), then `onExecutionEnd` / `onExecutionPause` / `onExecutionError` as for any pass.

<!-- snippet-context
import { Injectable, ResumeReason, type OnExecutionResume, type ExecutionResumeEvent } from "@agboss/core";
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
the instance's own sweep, waits for its running executions, and interrupts what is left a grace
before the end of the shutdown timeout (default `seconds(25)`; the grace `min(seconds(5), 20 %)` of
it, #367 S3): each releases its lease and stays `running`, so another instance takes it at its next
sweep, without waiting for the lease to expire. An
interrupted pass ends before the step bodies that ignore their signal return (LangGraph's
`invoke` / `stream` reject first, #340 S2), so the instance tracks every running body — an agent's,
a router's or an action's visit, a branch, a tool call — per tree, in process (#367): a tree's
lease is released only once its bodies returned, and `onDestroy` runs only once every body did,
both at the latest at the end of the shutdown timeout — the grace is spent on them, so the instance
ends within its shutdown timeout (`app.step-still-running` names a body still running then;
`close({ timeout: 0 })` stops waiting at once). Another instance therefore never reruns a step — the same action, the same
idempotency key — while its first run is still going here.

## Cancelling from any instance

`app.cancel(threadId, { tenantId, ownerId })` reaches the thread's execution on whichever instance
moves it (#360) — behind a load balancer a cancel lands on a random instance. Access is checked as
always (`UnknownThreadError` for another tenant's or an unknown thread, `ThreadOwnerError` for
another owner, `onExecutionRejected`), then:

1. **this instance runs it** — it is aborted at once, as before; nothing is written;
2. **it is paused** — it is dropped through the shared `PausedExecutionRepository`, its pauses
   withdrawn, as before;
3. **otherwise** every `running` root record of the thread gets a **cancel request**: the reserved
   tree key `@agboss/cancel-request` of the shared `ExecutionTreeRepository` (`{ requestedAt,
   ownerId }`, `saveIfAbsentInTree`, so two cancels write it once). The records are then read
   again: still `running` → `{ cancelled: true }`; paused meanwhile → the cancel waits for the
   holder's lease and ends the tree as cancelled; ended meanwhile → the request is removed with the
   tree's keys and `{ cancelled: false }`. A finished execution gets `{ cancelled: false }` and
   nothing is written.

The holder reads the request **after every lease renewal the store confirms** — the background one
every 10 seconds and the one before each checkpoint write — and before its tree rests paused. A found
request aborts the pass with `ExecutionCancelledError` (`thread "…" was cancelled`, the message of
a local cancel): the tool loop starts no further model or tool call, the record is failed,
`onExecutionError` fires once (on the holder's instance) and the holder's `execute` / `resume`
rejects. A store error reading the request is not a failure: it is read again at the next renewal.

**The request is durable.** An instance that takes a tree's lease reads it first: a waiting
`resume` ends the tree as cancelled and rejects with `ExecutionCancelledError`; recovery ends a
`running` root with a request instead of continuing it — on an instance of **any** config version,
since ending runs no graph (a root of another deploy without a request is still left to a compatible
instance). Ending without a pass fails the record, drops the paused run, withdraws its pauses,
removes its keys and fires `onExecutionError` once; there is no `onExecutionResume`.

**Known window.** An execution's `running` record is written after its budgets are opened and its
thread's compactions ran; a cancel from another instance before that moment finds nothing and
returns `{ cancelled: false }` (on the instance that started it the cancel still stops it).

**Reserved keys.** Tree keys starting with `@agboss/` belong to the framework — do not write them
from your own components ([below](#the-shared-state-of-one-request)).

## An undo interrupted mid-way

An execution that ends without a finish undoes its open undoable actions before it ends
([Rollback](Rollback#an-execution-that-ends-without-a-finish)). The undo is durable (#340 PR 4):

- before a root's undo starts, the holder writes the reserved tree key `@agboss/unwinding`
  (`{ reason, cause }` — why the tree ends: `CompensationReason.ExecutionFailed` or
  `ExecutionCancelled`, and the error's name and message; the first one written is kept), and after
  each undo action that succeeds `@agboss/compensated/<compensationKey>` (the automatic undo's own
  key, `<step key>:compensation`); a child's own undo writes `@agboss/unwinding:<childExecutionId>`;
- the root's record stays `running` until the undo ended — only then is it failed with its final
  error ([Rollback](Rollback#an-execution-that-ends-without-a-finish)) — so a stop (`app.close()`
  interrupting the undo at its shutdown timeout), a crash or a lost lease mid-undo leaves a
  `running` root with `@agboss/unwinding` for the recovery sweep;
- **whoever takes the tree's lease next** reads the key: recovery checks it before the
  compatibility check (like a cancel request, on an instance of any config version), and a waiting
  `resume` or a recovery at its lease take too. Found, the remaining undos run on the checkpoint
  state (pending writes applied, the children's namespaces included), the ones marked done skipped,
  then the tree ends failed with the recorded reason — its record failed, its pauses withdrawn, its
  keys removed, `onExecutionError` once (`ExecutionCancelledError` for a cancel, an `AGBossError`
  with the original message for a failure; `CompensationFailedError` when an undo failed) — and no
  pass runs; the log says `compensation.recovered`;
- **a child re-entered mid-undo** — the root's pass continued from its checkpoint, the child's step
  run again — reads its own key before its next step: found, the child takes no step, finishes its
  undo the same way and raises its error again, which its parent's side path may take.

An undo that failed is not marked done: the next holder runs it again. Each undo action gets the
same idempotency key on every instance, so an undo service that honours it sees one undo.

## The shared state of one request

`ExecutionTreeRepository` keeps keys under the request's root execution: visible to the whole tree
of executions at any depth and on any instance, invisible to other requests, removed when the tree
finishes, fails or is cancelled (a pause keeps them). `saveIfAbsent` is atomic — of two branches
claiming one key exactly one gets `true`. Keys starting with `@agboss/` are reserved for the
framework (`@agboss/cancel-request`, [above](#cancelling-from-any-instance); `@agboss/unwinding`,
`@agboss/unwinding:<childExecutionId>` and `@agboss/compensated/<compensationKey>`,
[above](#an-undo-interrupted-mid-way)). Keys come from
identifiers in DTOs, never from text:

<!-- snippet-context
import { Text } from "@agboss/core/dto";
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
import { ExecutionTreeRepository, Tool, type ToolHandler } from "@agboss/core";

@Tool({
  name: "claim-subtopic-tool",
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

## PII tokens across instances

A `replaceWithToken()` token is an HMAC of the value, so one value is one token only under one key
([Guards → PII policies](Guards#pii-policies)). With `@Application({ pseudonymKey })` every instance
has the same key: one value is one token everywhere. Without it (S94, #334) the key is the
**execution's**: each root execution makes a random one when it starts and keeps it in its
checkpoint (the state's `piiKey`, next to its token map `piiTokens`); its child workflows get it
with the tokens. Whichever instance continues it — `app.resume` on another instance, a recovery
after its holder died — reads the key from the checkpoint, so a value the model saw as
`<author:3f9a1c>` before the pause is `<author:3f9a1c>` after it, in the parent and in its children
alike. Another execution gives the same value another token. The key never leaves the checkpoint:
traces show it as `***`, and logs and traces mask with a key of the instance. A checkpoint written
before #334 has no key: its execution goes on with the key of the instance that continues it.

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
  selectOne(): Promise<void> {
    return Promise.resolve();
  }
}
-->

```ts
import { ExecutionLeaseRepository, Injectable, type ExecutionLease } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";

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

  override ping(): Promise<void> {
    return this.leaseTableService.selectOne(); // one round trip: what readiness calls (#300)
  }
}
```

Every store contract has `ping()` (#300): one fast round trip that resolves when the store answers
and rejects with why when it does not — `app.checkReadiness()` calls it under a `seconds(2)`
timeout, and a rejection or a timeout is that store's `Unhealthy` ([Health checks](Health-checks)).

## Testing several instances

`testWith(App, { instances: 2 })` runs two application instances in one test — `apps[0]` (= `app`)
and `apps[1]`, each with its own container and instance id — over one set of stores and one clock
(`clock`, shared). With the in-memory defaults the instances share their rows, so the framework's
own implementations are tested across instances; nothing is substituted, so an application that
lists its own implementations is tested on those (against Testcontainers, or with its injected
client replaced by `mockOf(…)`).

**SQLite stores are shared only through a file** (#458). Each instance opens its own connection
([above](#sqlite--several-instances-on-one-machine)), and SQLite's `:memory:` is one database per connection: with
`sqlitePath: ":memory:"` — the usual `test` environment — the two instances of
`testWith(App, { instances: 2 })` each get an empty database of their own, and a pause made on
`app` is not found on `apps[1]`. A multi-instance test runs on an environment whose `sqlitePath` is
a file, a fresh one per test process, as flow-patterns' `instances` environment does:

```ts no-check: AppEnvironment is the project's environment contract (see Environments)
// src/environments/instances.environment.ts
export const environment: AppEnvironment = {
  sqlitePath: join(mkdtempSync(join(tmpdir(), "app-instances-")), "stores.sqlite"),
};

const test = testWith(App, { instances: 2, env: "instances" });
```

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

## Probes of an instance (#300)

Each instance answers its orchestrator's probes through `app.checkLiveness()` and
`app.checkReadiness()` — the project's server maps them to its endpoints ([Health checks](Health-checks)).
Liveness does no I/O: an instance that is stopping (`app.close()`, SIGTERM) is `Unhealthy`
(`stopping`) so the orchestrator stops sending it traffic while it drains, and a recovery loop whose
last sweep ended more than three sweep intervals (90 s) ago is `Unhealthy` (`stuck: …`) — a store it
waits on that never answers. Readiness adds every store's `ping()` and the circuit breakers of the
model providers as `RateLimitRepository` keeps them for every instance: an open breaker makes every
instance `Degraded` at once (it still serves; calls go to the fallback or fail fast), never
`Unhealthy`. An instance that caps its steps ([below](#an-instances-cap-on-steps-332)) is `Degraded`
while every step slot is busy.

## An instance's cap on steps (#332)

One instance has finite memory and CPU: a burst of `app.execute` calls across tenants, or trees that
fan out into many parallel agents on the same pod, would otherwise all run in it at once.
`@Application({ maxConcurrentSteps })` caps how many **agent, router and action steps** — each
branch of a parallel launch is one — this instance runs at once, over every tree and every tenant:

<!-- snippet-context
import { Application, EmptyEnvironment } from "@agboss/core";
export class DeskWorkflow {}
export class ApplicationDailyBudget {}
export class TenantDailyBudget {}
export class ExecutionBudget {}
-->

```ts
@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  maxConcurrentSteps: 32, // this instance's agent, router and action steps at work at once
})
export class DeskApplication {}
```

- A whole number from 1 (`[limits.max-concurrent-steps-invalid]` at assembly: 0, -1 and 2.5 fail);
  **unset → no cap** — nothing changes for an application that does not set it.
- A step takes its tree's slot ([`maxConcurrentExecutions`](FinOps#concurrency-of-a-tree-264)), then
  one of the instance's, with the same claim; both are released when the step ends, fails or
  pauses. A start, a finish, a join and a child workflow's node take none.
- A step without a free slot **waits** — never an error — in the same order as the tree's queue: a
  step that closes a branch (right after its child, or its children's join) first, then the
  deepest execution, every 10 s of waiting counted as one level deeper (`AGING_STEP`, on the
  `Clock`); a new root's first step is depth 1, so it comes last. A waiter whose execution is
  cancelled, or whose launch fails fast, leaves the queue. A quorum's `deadline` excludes the
  time its branches wait for either slot.
- A step waiting in a model provider's rate-limit queue (#266) **keeps** its slot.
- No deadlock: a launch's slot comes before the tree's, the tree's before the instance's, and a
  step holding an instance slot needs nothing else to end. The one exception is your own: a tool
  that calls `app.execute` on the same instance while its step holds a slot needs a slot of its own.
- At `app.close()` the waiting steps wait with the running ones until a grace before the end of the
  shutdown timeout (#367 S3), then are interrupted like them (`ApplicationStoppingError`, the record stays `running`, the lease released
  at once) and another instance [recovers](#recovery) the tree.
- **Recovery** on a full instance: its sweep starts at most as many recoveries per look as it has
  free step slots — none when it is full — so the orphans go to an idle instance. A look cut short
  that way goes on where it stopped the next time, so every `running` root is reached in turn.
- **Readiness**: a full instance reports the component `step-slots`
  ([`HealthComponentKind.StepSlots`](Health-checks#the-report)) as `Degraded` —
  `"32 of 32 step slots busy, 7 steps waiting"` — and `Healthy` again once a slot frees; liveness is
  not affected. A load balancer that reads readiness sends new requests to the other instances.
- `agboss describe` prints `maxConcurrentSteps 32 (set)` (or `none (not set)`); `describe --json` has
  `application.maxConcurrentSteps` (`null` when unset).
- The slots are in-process (one `StepSlots` per `createApp`); they are not shared through a store —
  each instance caps itself.

## Children on any instance (#333)

A whole execution tree normally runs on the instance that holds its lease. A child launched with
`placement: ChildPlacement.AnyInstance` ([Workflow as a step](Workflow-as-a-step#on-any-instance-333-pr-2))
may run on **any** instance instead, through the application's `ChildExecutionQueueRepository`
(#333 PR 2):

1. The parent's node saves the child to the queue — `saveIfAbsent`, keyed by `(tenantId,
   executionId)`, its row `Queued` with what a worker needs to run it (its first state, its own
   thread, its parents as plain data, serialized with the checkpointer's `serde`) — and waits inside
   its step on that row: woken at once when the child ends in the same process, else reading the row
   every second on the `Clock`. While waiting, the parent yields its lease in
   `ExecutionLeaseRepository` and re-acquires it before continuing (#333 PR 4, S9).
2. Every instance whose workflows launch such a child claims queued rows while it has a free step
   slot ([#332](#an-instances-cap-on-steps-332); no cap → always): at once when a child is queued in
   its own process, and at every sweep (30 s) for the ones queued elsewhere.
   `claimFirstByStatusQueuedOrderByDepthDesc` takes the deepest child first, then the longest
   waiting, and marks it `Running` with its `instanceId` — atomically (`BEGIN IMMEDIATE` on SQLite),
   so of two instances exactly one gets it.
3. The claiming instance holds a 30 s lease in `ExecutionLeaseRepository` under
   `(tenantId, childExecutionId)`, runs the child as a root graph on its own thread (ADR-0022) on
   the same checkpointer, then `completeByTenantIdAndExecutionId` marks the row `Answered`,
   `Paused` (when the child rests at a pause) or `Failed` (the names, codes and messages of its
   error chain). When the row is `Paused`, the parent's node interrupts with a `remote: true`
   waiting marker so the pause appears in `result.pending`, and on `app.resume` forwards the child's
   resume map through the queue so any instance continues it (#333 PR 4). On a worker crash or a
   graceful stop past `shutdownTimeout` (S7), the row stays `Running`, and once the child's lease is
   free a live worker reclaims only that child and continues it from its last checkpoint.
4. While it runs, the worker looks every 10 s whether the tree still waits for it: a cancel request
   ([Cancelling from any instance](#cancelling-from-any-instance)) or the tree's end — its root's end
   removes its rows (`deleteAllByTenantIdAndRootExecutionId`) — aborts it.

List `SqliteChildExecutionQueueRepository` (table `child_execution_queue`) or your own `extends
ChildExecutionQueueRepository`; on the built-in in-memory queue only the instances of one process
(a test's) share it — `[application.in-memory-child-queue]`. The queue, the checkpointer, the
ledger, the leases, the paused executions and `RateLimitRepository` must be shared for a child to
run elsewhere. For a tree that can launch on any instance (#333 PR 3, S8), `maxConcurrentExecutions`
is held as leases in `RateLimitRepository` (`tree:<tenantId>:<rootExecutionId>` and
`:subtree:<executionId>`, renewed while held, polled on the `Clock`), depth and the root's budgets
are checked where the child runs, and each superstep's spend reaches the root's counters at once.

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
- A cancel from another instance reaches a running execution within one lease renewal (10 s, or
  its next checkpoint write), not at once; one made before the execution's `running` record exists
  is not seen ([Cancelling from any instance](#cancelling-from-any-instance)).
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
own implementation (Redis, …) `extends RateLimitRepository` and implements all eight methods (`ping()` included, #300); the
shared contract suite of the framework (`tests/infrastructure/rate-limit.contract.test.ts`) is the
behaviour to match.

**Standalone executable proof:** [`05-cluster-work-stealing`](https://github.com/agbossjs/agboss-examples/tree/main/05-cluster-work-stealing) in [`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples) — see [Example](Example#standalone-verified-applications-agbossjsagboss-examples).
