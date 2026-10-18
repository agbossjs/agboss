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
| `RateLimitRepository`       | a model provider's limit is common to every instance (#266)                     |

The ready SQLite implementations (`SqliteExecutionLeaseRepository`, …) come with #265 PR 3; until
then a project lists its own (`extends` the contract, `@Injectable({ deps })`).

## The execution lease

One lease per execution tree, keyed by `(tenantId, rootExecutionId)` — `tenantId` is `"default"`
until tenants come (#261). Whoever moves the tree holds it: `app.execute` from its first step,
`app.resume` once it has recorded its decision. The holder:

- renews the lease in the background every 10 seconds (a third of its fixed length, `seconds(30)` —
  not a setting) and right before every checkpoint write;
- releases it when its pass ends — the tree paused, finished or failed. A paused or finished tree
  holds no lease;
- when a renewal answers `false` (the lease expired — the instance was frozen or cut off for longer
  than 30 seconds — and another instance took it, `leaseEpoch + 1`), stops: its work is aborted
  through its signal and its call rejects with `ExecutionLeaseLostError` (`execution.lease-lost`).
  That is not a failure of the execution: it reaches neither `.onError`, `onError` nor the execution
  record — the new holder owns the execution and continues it.

**Two resumes at once.** A resume has two phases: it first records its decision (the pause goes
`Pending → Resolved` atomically — a second resume of the same pause, a double click, gets
`NotPausedError`), then takes the tree's lease. While another call or instance holds it, the
resume waits; the holder, before it lets the tree rest paused, takes the decisions resolved
meanwhile, so the waiting call then returns the tree's current `ExecutionOutput`, its decision
taken. If the holder's lease expires while a call waits, the waiting call takes it and goes on.

**Documented limit.** The renewal before a checkpoint write and the write are two round trips to the
stores, not one atomic operation (`BaseCheckpointSaver` is taken as is, so ecosystem savers plug
in): the race window is one round trip.

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
time value comes from the framework (`lease` is a duration, `expiresAt` a `Date`), never from the
store's own clock:

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

  const resumed = await apps[1].resume(paused.thread, { approved: true, by: "dana" });

  expect(resumed.output).toEqual({ text: "Charged." });
});

test("a holder frozen past the lease loses it", async ({ clock }) => {
  // … one instance moves the tree, the other waits for it …
  await clock.advance(seconds(31)); // the time jumps: the waiting instance takes the lease first
});
```

`await clock.advance(d)` lets the work already started reach its next wait, moves the time, then
wakes every wait that is due in time order (lease renewals, a resume waiting for a lease) — a jump
longer than the lease is a holder frozen for that long.

## Limits

- With the in-memory defaults nothing is shared between instances and nothing survives a restart:
  run one instance, or list shared stores.
- Recovery of a tree whose holder died with nobody waiting (its record left running) comes with
  #265 PR 2.
- Fairness between tenants waiting for a model provider's slots is per instance (#266).
