# 09 — Persistence, Kubernetes and deploys

Read this when you make an application durable (its stores), run it as several instances, expose
health probes, stop it gracefully, or deploy a new version while executions are paused or running.
Budgets' counters are in reference 06, pauses in reference 05, the undo's durability in reference 02.

## Storage: where the rows go

An application's durable rows go where its `storage` says (#1321): `@Application({ storage:
AppDatabaseStorage })` — a class decorated `@DatabaseStorage({ driver, auditLogTtl, ledgerEntriesTtl })`
— or `storage: { database, cluster?, objects? }` with a `@ClusterStorage({ driver })` (the rows that
coordinate instances — leases, the child queue, rate limits) and an `@ObjectStorage({ driver })` (files:
`S3Driver`, `LocalDiskDriver`). A **driver** holds its connection settings with `env(…)` / `secret(…)`
references, read once when the application starts, so `@Application` carries no host or password:
`SqliteDriver({ path })` is the core's; `PostgresDriver`, `MongoDriver` and `RedisDriver` come from the
store packages (`@agboss/postgres`, `@agboss/mongodb`, `@agboss/redis`). The stores come from the drivers
— a store class listed in `providers` beside `storage` is `[storage.providers-conflict]`, a workflow's
`providers` is `[di.infrastructure-in-workflow]`. With no `storage` the built-in in-memory stores run
(`InMemoryDatabaseStorage`): nothing shared between instances, nothing survives a restart, and the
`[application.in-memory-…]` warnings say so (an error under `--strict`).

| What the database holds              | Used by                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| checkpoints                          | every step's checkpoint: a pause, a crash and a resume continue from it        |
| execution records                    | threads, owners, execution records, who answered each pause, summaries         |
| pauses (`PausedExecutionRepository`) | each pause's record (`Pending → Resolved → Taken`, or `Cancelled`) and notices |
| cost ledger                          | the budgets' counters (reference 06); `ledgerEntriesTtl` keeps its entries     |
| leases, execution trees              | one lease per execution tree: who moves it; cancel requests, the undo's marks  |
| rate limits                          | a provider's slots, per-minute windows, 429 pause and circuit breaker          |
| execution history                    | each root execution's history, only with `retention.executionRecords` (below)  |
| audit log                            | every takeover of a lease and every step handed over; kept `auditLogTtl`       |
| fenced effects, outbound calls       | `Idempotency.runOnce` / `sendOnce` (below)                                     |

`@DatabaseStorage` requires `auditLogTtl` (a duration, `Ttl.Forever` or `Ttl.None`) and `ledgerEntriesTtl`
(above the 30 s lease) — `[storage.ttl-invalid]` — and names its keys: `idempotencySecret`,
`piiSecret` (reference 07), each a `secret(…)` of its own (`[storage.secret-shared]`,
`[storage.key-conflict]`). `retention.auditLog` and `retention.costLedgerEntries` beside `storage` are
`[storage.retention-conflict]`. A `@ClusterStorage` needs a database whose driver keeps durable lease
rows (`[storage.cluster-needs-durable-lease-store]`) and a database beside it
(`[storage.database-required]`). A class in `storage` without its decorator is
`[storage.not-a-storage]`, a bad driver `[storage.driver-invalid]`.

The SQLite driver shares **one file** over one `node:sqlite` connection per instance (the
`SqliteConnection` token), in WAL mode with a 5 s busy timeout; every atomic operation runs in one
`BEGIN IMMEDIATE`, every time value comes from the application's `Clock`. SQLite shares state
between **processes on one machine** (one volume). Several machines need a networked database:
`PostgresDriver` or `MongoDriver` for the rows, `RedisDriver` as the `@ClusterStorage`. A schema change
of a networked store is `npx agboss migrate db` (stop the old version first; live leases refuse it unless
`--allow-live-leases`); SQLite creates its schema when it opens the file.

## The worked example: a durable application

```ts file=src/environments/app.environment.ts
export class AppEnvironment {} // the storage's path and the keys are env(…) / secret(…) in its decorator
```

```ts file=src/environments/prod.environment.ts
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {};
```

```ts file=src/environments/test.environment.ts
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {};
```

The storage: SQLite in the file `AGBOSS_SQLITE_PATH` names (a persistent volume), the keys from the
process. A test sets the variable to `:memory:` in its vitest config (`agbossVitest({ env: {
AGBOSS_SQLITE_PATH: ":memory:" } })`); `testWith` has keys of its own.

```ts file=src/claims/storages/claims.database-storage.ts
import { DatabaseStorage, SqliteDriver, defineEnv, env, secret } from "@agboss/core";
import { hours } from "@agboss/core/units";

const databaseEnv = defineEnv({
  path: env("AGBOSS_SQLITE_PATH", { default: "/data/claims.sqlite" }), // a persistent volume
  idempotencySecret: secret("AGBOSS_IDEMPOTENCY_SECRET"),
});

@DatabaseStorage({
  name: "claims-database-storage",
  driver: SqliteDriver({ path: databaseEnv.path }),
  auditLogTtl: hours(24 * 30),
  ledgerEntriesTtl: hours(24),
  idempotencySecret: databaseEnv.idempotencySecret, // a key of its own: business keys of Idempotency
})
export class ClaimsDatabaseStorage {}
```

```ts file=src/claims/dto/claim-assessment.dto.ts
import { Text } from "@agboss/core/dto";

export class ClaimAssessmentDto {
  @Text({ prompt: "the assessment of the claim" })
  assessment!: string;
}
```

```ts file=src/claims/workflows/claim/claim.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "claim-workflow-start", description: "An insurance claim", input: WorkflowStartTextDto })
export class ClaimWorkflowStart {}
```

```ts file=src/claims/agents/claim-assessor/claim-assessor.agent.ts
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { ClaimAssessmentDto } from "../../dto/claim-assessment.dto.js";

@Agent({
  name: "claim-assessor-agent",
  description: "Assesses a claim",
  prompt: inline("Assess the claim in three sentences."),
  model: "moonshotai/kimi-k2.6",
  input: { claim: WorkflowStartTextDto },
  output: ClaimAssessmentDto,
})
export class ClaimAssessorAgent {}
```

```ts file=src/claims/workflows/claim/claim.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { ClaimAssessmentDto } from "../../dto/claim-assessment.dto.js";

@WorkflowFinish({ name: "claim-workflow-finish", description: "The assessment", output: ClaimAssessmentDto })
export class ClaimWorkflowFinish {}
```

```ts file=src/claims/workflows/claim/claim.workflow.ts
import {
  Workflow,
  WorkflowSettings,
  onStart,
  ResumeDecision,
  type IncompatibleResume,
  type WorkflowDefinition,
  toAgent,
  toFinish,
  Ttl,
} from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { ClaimAssessorAgent } from "../../agents/claim-assessor/claim-assessor.agent.js";
import { ClaimAssessmentDto } from "../../dto/claim-assessment.dto.js";
import { ClaimWorkflowFinish } from "./claim.workflow-finish.js";
import { ClaimWorkflowStart } from "./claim.workflow-start.js";

/** A paused or running execution of another config hash is continued only when the version is the same. */
const sameVersionOnly = (resume: IncompatibleResume): ResumeDecision =>
  resume.paused.workflowVersion === resume.current.workflowVersion
    ? ResumeDecision.Resume
    : ResumeDecision.Reject;

@Workflow({
  name: "claim-workflow",
  version: "1.1.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ClaimWorkflowStart)
      .toAgent(ClaimAssessorAgent)
      .toFinish(ClaimWorkflowFinish),
  ],
  executionLimits: { maxSteps: 1 },
})
export class ClaimWorkflow implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .onIncompatibleResume(sameVersionOnly)
      .build();
  }
}
```

```ts file=src/claims/services/claims-api.service.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class ClaimsApiService {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
```

```ts file=src/claims/health-checks/claims-api.health-check.ts
import { HealthCheck, HealthCheckResult } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { ClaimsApiService } from "../services/claims-api.service.js";

@HealthCheck({ name: "claims-api-health-check", timeout: seconds(2), deps: [ClaimsApiService] })
export class ClaimsApiHealthCheck {
  constructor(private readonly claimsApiService: ClaimsApiService) {}

  async check(): Promise<HealthCheckResult> {
    return (await this.claimsApiService.ping())
      ? HealthCheckResult.healthy()
      : HealthCheckResult.degraded("claims API is slow"); // still serves
  }
}
```

```ts file=src/claims/budgets/application-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}
```

```ts file=src/claims/budgets/tenant-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}
```

```ts file=src/claims/budgets/execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
```

The chat provider — every application names its `modelProvider` explicitly (a driver provider; no built-ins):

```ts file=src/model-providers/openrouter.model-provider.ts
import { secret } from "@agboss/core";
import { ModelCost, ModelProvider, OpenRouterDriver } from "@agboss/core/models";
import { minutes } from "@agboss/core/units";

@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — every chat model of the application",
  driver: OpenRouterDriver({ apiKey: secret("OPENROUTER_API_KEY") }),
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
})
export class OpenRouterModelProvider {}
```

```ts file=src/claims.application.ts
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";
import { Application } from "@agboss/core";
import { hours, seconds } from "@agboss/core/units";
import { ApplicationDailyBudget } from "./claims/budgets/application-daily.budget.js";
import { ExecutionBudget } from "./claims/budgets/execution.budget.js";
import { TenantDailyBudget } from "./claims/budgets/tenant-daily.budget.js";
import { ClaimsApiHealthCheck } from "./claims/health-checks/claims-api.health-check.js";
import { ClaimsApiService } from "./claims/services/claims-api.service.js";
import { ClaimsDatabaseStorage } from "./claims/storages/claims.database-storage.js";
import { ClaimWorkflow } from "./claims/workflows/claim/claim.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";

@Application({
  modelProvider: OpenRouterModelProvider,
  name: "claims-application",
  version: "1.1.0",
  environment: AppEnvironment,
  workflows: [ClaimWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  // every store durable and shared: no [application.in-memory-…] warning
  storage: ClaimsDatabaseStorage,
  providers: [OpenRouterModelProvider, ClaimsApiService],
  healthChecks: [ClaimsApiHealthCheck],
  retention: {
    pauseRecords: hours(24), // resolved pause records kept this long, then swept
    executionRecords: hours(24 * 30), // each root execution's history, 30 days after it ended
  },
  executionLimits: {
    shutdownTimeout: seconds(25), // under the platform's 30 s grace period and the 30 s lease
    compensationTimeout: seconds(15), // each automatic undo's clean-up signal
    maxConcurrentSteps: 32, // agent, router and action steps of this instance at once
  },
})
export class ClaimsApplication {}
```

The process: `createApp` closes the app on SIGTERM / SIGINT by itself; the project's server maps the
probes to its endpoints (liveness: `report.isAlive`; readiness: `report.isReady` — 503 when `Unhealthy` or busy, 200 otherwise; a `Degraded` instance still serves):

```ts file=src/http/server.ts
import { createServer } from "node:http";
import { createApp, type HealthReport } from "@agboss/core";
import { ClaimsApplication } from "../claims.application.js";
import { ClaimWorkflowStart } from "../claims/workflows/claim/claim.workflow-start.js";

const app = await createApp(ClaimsApplication, { env: "prod" }); // listens for SIGTERM / SIGINT

const probeOf = (path: string | undefined): Promise<HealthReport> | undefined =>
  path === "/livez" ? app.checkLiveness() : path === "/readyz" ? app.checkReadiness() : undefined;

createServer((request, response) => {
  const probe = probeOf(request.url);
  if (probe !== undefined) {
    void probe.then((report: HealthReport) => {
      response.writeHead(report.isReady ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(report));
    });
    return;
  }
  void app
    .execute(ClaimWorkflowStart, { text: "a claim" }, { tenant: { tenantId: "acme" } })
    .then((result) => response.end(JSON.stringify(result.output)));
}).listen(8080);
```

## Health probes

`app.checkLiveness()` / `app.checkReadiness()` → `HealthReport { status, components, isBusy, isAlive, isReady }` — never a
rejection; `status` is the worst component's `HealthStatus.Healthy | Degraded | Unhealthy`, each
`HealthComponentReport { name, kind: HealthComponentKind, status, reason?, duration }`.

| Probe     | Components                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| liveness  | no I/O: the application (`Unhealthy`, `stopping` from `app.close()` on) and the recovery loop (`Unhealthy` when its last sweep ended over 90 s ago)                                                              |
| readiness | liveness's, one `ping()` per storage component (`seconds(2)` each), every model provider's circuit breaker (open → `Degraded`), every `@HealthCheck` of `@Application({ healthChecks })` under its own `timeout` |

A check that throws or times out is that component's `Unhealthy` (`check(ctx)` gets `HealthCheckContext`: its `signal` aborts at the timeout). `HealthCheckResult.healthy()` /
`.degraded(reason)` / `.unhealthy(reason)` are the only results (a plain object does not
compile); `[health.not-a-health-check]`, `[health.duplicate-name]`.

## Metrics for autoscaling (#485)

`createApp(App, { meterProvider })` publishes the instance's metrics through an OpenTelemetry
`MeterProvider` the project builds (an SDK one with `@opentelemetry/exporter-prometheus` or an OTLP
exporter to a Collector); none given → no metrics, nothing loaded. `testWith(App, { instances:
[{ meterProvider }, …] })` gives each instance its own, read with an in-memory `MetricReader`.

| Metric                                                                                  | Kind                                                        | Labels                                    | Aggregate                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `agboss.cluster.children.queued` / `.running` / `.oldest_queued.age`                    | gauge, read from the shared child queue (`countByStatus()`) | —                                         | `max` — every pod reports the same value |
| `agboss.instance.step_slots.limit` / `.busy` / `.free`, `agboss.instance.steps.waiting` | gauge (only with `maxConcurrentSteps`)                      | —                                         | `sum`                                    |
| `agboss.instance.leases.held`                                                           | gauge                                                       | —                                         | `sum`                                    |
| `agboss.instance.leases.takeovers`                                                      | counter                                                     | `reason`                                  | `sum`                                    |
| `agboss.instance.steps.handed_over`                                                     | counter                                                     | `reason`                                  | `sum`                                    |
| `agboss.instance.executions.ended`                                                      | counter                                                     | `workflow`, `outcome`                     | `sum`                                    |
| `agboss.instance.compensations`                                                         | counter                                                     | `workflow`, `outcome`                     | `sum`                                    |
| `agboss.instance.costs.unknown`                                                         | counter                                                     | `workflow`                                | `sum`                                    |
| `agboss.instance.costs.unknown_unrecorded`                                              | counter                                                     | `workflow`                                | `sum`                                    |
| `agboss.instance.pauses.opened` / `.timeout_changed` / `.reassigned`                    | counter, `{pause}` (#943)                                   | `workflow`, `target`, `channel`           | `sum`                                    |
| `agboss.instance.pauses.closed` / `.answers_not_taken`                                  | counter, `{pause}` (#943)                                   | `workflow`, `target`, `channel`, `reason` | `sum`                                    |
| `agboss.instance.pauses.time_to_answer`                                                 | histogram, `s`, human answers only (#943)                   | `workflow`, `target`, `channel`           | `sum` the buckets                        |
| `agboss.cluster.pauses.notices.waiting` / `.dead`                                       | gauge, `{mailbox}`, read from the pause store (#943)        | —                                         | `max` — every pod reports the same value |

Scale out on the slot demand `max(queued) + sum(waiting) + sum(busy)` per `maxConcurrentSteps`;
the application is idle only when `max(queued) + max(running) + sum(leases.held) + sum(busy) +
sum(waiting)` is 0. Never sum a cluster gauge over pods; never label by tenant or execution (a pause's `target` and `channel` are the names of its target and its channel). `app.listPauses({ tenantId, status?, role?, expiringBefore?, limit?, after? })` lists a tenant's pauses page by page for an operator's queue. Match
`terminationGracePeriodSeconds` to `shutdownTimeout` plus the preStop delay. Wiki → Metrics,
Autoscaling.

## Several instances

- **The lease.** `execute` / `resume` move a tree only while holding its lease (keyed by `tenantId`
  and the root execution id, `seconds(30)`, renewed every 10 s and before every checkpoint write).
  A holder that lost it stops: its call rejects with `ExecutionLeaseLostError` — no `.onError`, no
  failed record; the new holder owns the execution.
- **Recovery.** Every instance looks for `running` roots at start and every 30 s, takes the lease of
  one whose holder died or stopped, and continues it from its last checkpoint — only the interrupted
  step runs again (`onExecutionResume` with `ResumeReason.Recovered`; the log's
  `execution.recovered`). An interrupted automatic undo is finished the same way.
- **At least once.** A step can run twice (a crash after its side effect, before its checkpoint):
  pass `executionContext.step.idempotencyKey` —
  `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, the same on a rerun — to
  every external side effect, and make each undo safe to run twice.
- **Fencing (#471, #1317c).** Domain code has no `executionContext.fence` and no raw transaction:
  `Idempotency.runOnce` / `sendOnce` read the lease the step runs under (`scopeKey`, `token`, the monotonic fencing token) and make
  the key; a write refused because the lease moved is `ExecutionError.Fenced` (a hand-over, no
  `.onError`). `ExecutionFence` is a type of `@agboss/core/stores`, for store authors. A reply
  interpreter, a budget's `maxSpend()` and an eval judge have no lease (`ExecutionContextUnavailableError`).
- **The idempotent write (#500).** For rows in the store's own database, one call does the fencing and
  the deduplication: inject `Idempotency` (#890, never a store's class) and call
  `runOnce({ name: "charge", ttl: hours(24), execute: () => repository.write(…) })` — on the
  application's database storage (the SQLite one, a networked one, or the in-memory default) — the lease,
  the scope's mark and the step's key checked in the write's transaction, which your repository joins
  (`sqliteConnection.requireTransaction()`; `execute` gets no transaction argument and is synchronous); a replay gets the stored result, a zombie `ExecutionError.Fenced`.
  No fencing or idempotency table of your own.
- **Calls that leave the system (#505).** `idempotency.sendOnce({ name: "charge", target, request,
timeout, ttl, send, recovery })` records the intent first
  and recovers one left pending; `recovery` is required (#795): `OutboundRecovery.permanentLookup(lookup =>
Reconciliation…)` when the lookup reads the other system's own records, `OutboundRecovery.lookupWithin(hours(24), …)` or
  `OutboundRecovery.replayWithin(hours(24))` when a resend relies on the key's replay (`timeout` below the window, `ttl` at least it). An attempt answered
  after a newer one took it over fails the step with `OutboundCallError.Superseded`.
  `app.pendingOutboundCallsOf({ tenantId, limit?, after? })` pages what waits for an operator
  (`{ calls, next? }`, #825).
- **Business keys (#508, #825).** `runOnce({ name: "charge", key: "order:42", fingerprint: { amountUsd }, ttl, execute })` — one effect per tenant, name and business key, another
  fingerprint a conflict; a keyed `runOnce` needs `fingerprint` or `withoutFingerprint: true`
  (a compile error without), a keyed `sendOnce` needs neither (its
  request the fingerprint). The fingerprint is keyed by `@DatabaseStorage({ idempotencySecret })` — a
  `Secret` of its own, required where business keys can be made; rotate it with
  `previousIdempotencySecret` (compared under both, stored under the current one) and drop the
  previous secret once nothing recorded under it can be retried.
- **Any instance answers.** A pause made on one instance is resumed on another; `app.cancel` reaches
  the tree on whichever instance moves it.
- **The cap on steps.** `@Application({ executionLimits: { maxConcurrentSteps } })` (a whole number from 1,
  `[limits.max-concurrent-steps-invalid]`; unset → no cap) bounds the agent, router and action steps
  one instance runs at once over every tree and tenant — a queue, never an error; readiness is
  `isBusy` (so not `isReady`) while every slot is taken, and the recovery sweep starts at most its free slots' worth.
- **PII tokens** are the same on every instance only with `@DatabaseStorage({ piiSecret })` (reference 07).

## Stop, pause, unpause and cancel an execution

Four operator commands, each on a thread, each durable on the tree's lease row (the database is the
authority, whatever a coordination store says) and each idempotent — a repeat writes again, so a
command that died half way is completed by the operator's retry. Precedence is `Cancel > Stop > Pause`.

- `app.cancel(threadId, { reason })` aborts the run and undoes what it had undoable (`compensateWith`);
  `execute` / `resume` resolve `ExecutionStatus.Cancelled`.
- `app.stop(threadId, { reason, mode })` halts where it stands: nothing is undone;
  `ExecutionStatus.Stopped`.
- `app.pause(threadId, { reason, mode })` freezes the execution at a checkpoint; its call resolves
  `ExecutionStatus.Paused` with `isExternallyPaused: true`; `app.unpause(threadId)` continues it from
  that checkpoint (`ResumeReason.Unpaused`). A tree resting at a business pause (`@ExternalTask`,
  `@ToolApproval`) is `dual_paused`: an answer is refused (`ExecutionError.ExternallyPaused`), a
  deadline and a channel decision wait, until `app.unpause`.
- `mode` is `InterruptMode.AfterStep` (default: the step in flight finishes and commits, none starts)
  or `InterruptMode.Immediate` (the step in flight is aborted and the tree's token is fenced: its
  late writes are refused with `ExecutionError.Fenced`; a pause's fence is never lowered, a cancel
  after it unwinds on a lease at a higher token).
- A step registers `executionContext.onInterrupted(cleanup)`: awaited, newest first, only when the
  step is interrupted (told `InterruptReason.Paused | Stopped | Cancelled | TimedOut | HandedOver`),
  bounded all together by `executionLimits.shutdownTimeout`; a failing cleanup is
  `onInterruptCleanupError`, never `onExecutionError`.
- `app.getStatusHistory(threadId)` lists the thread's status transitions (`running`, `pausing`,
  `externally-paused`, `dual-paused`, `stopping`, `stopped`, `cancelling`, `cancelled`, …), each
  written in the transaction of the change.
- Returns: `{ state }` — `PauseRequestState` / `StopRequestState` (`Paused`/`Stopped` before the call
  returned, `Pausing`/`Stopping` durable and winding down, `NotRunning`).

## A graceful stop

`app.close({ timeout? })` (and SIGTERM / SIGINT through `createApp`):

1. no new execution: `execute` / `resume` reject with `ApplicationStoppingError` (`app.stopping`),
   observers get `onExecutionRejected`; `cancel` still works; liveness turns `Unhealthy`;
2. the instance's recovery sweep stops, then every component's `onStop`;
3. running executions are awaited until a grace before the end of the shutdown timeout
   (`@Application({ executionLimits: { shutdownTimeout } })`, default `seconds(25)`; the grace `min(5 s, 20 %)`), then
   interrupted — their calls reject with `ApplicationStoppingError`, their leases are released at
   once, their records stay `running`, so another instance continues them at its next sweep;
4. the step bodies still running get the grace (a lease is released only once its tree's bodies
   returned, so no other instance reruns a step meanwhile), then `onDestroy` and the connections close.

`app.close({ timeout: seconds(0) })` interrupts at once. A second signal while stopping interrupts at
once too. `testWith` never listens for signals.

## Kubernetes

```yaml
# deployment.yaml — one pod per instance; SQLite needs every replica on one node and one volume
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claims
spec:
  replicas: 1 # more replicas on several nodes: your own shared stores instead of SQLite
  template:
    spec:
      terminationGracePeriodSeconds: 30 # above shutdownTimeout (25 s)
      containers:
        - name: claims
          image: registry.example.com/claims:1.1.0
          env:
            - name: AGBOSS_SQLITE_PATH
              value: /data/claims.sqlite
            - name: OPENROUTER_API_KEY
              valueFrom: { secretKeyRef: { name: claims, key: openrouter-api-key } }
          livenessProbe: { httpGet: { path: /livez, port: 8080 }, periodSeconds: 10 }
          readinessProbe: { httpGet: { path: /readyz, port: 8080 }, periodSeconds: 5 }
          volumeMounts: [{ name: data, mountPath: /data }]
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: claims-data }
```

`npx agboss check --env prod` lists the process variables the environment needs (names only, `value`
or `secret`, `optional` / `has a default`) — the list for the manifest.

## Deploying a new version

- **The config hash** (`configHash`, printed by `npx agboss describe --json` and carried by every
  record, event and trace) is the fingerprint of a workflow's config, flow and every text its models
  read — its child workflows' included.
- A paused or running execution started under another hash is **not** continued by an instance of
  the new version unless the workflow's `onIncompatibleResume` policy says `ResumeDecision.Resume`
  (`implements WorkflowDefinition`, `settings()` above): `app.resume` rejects with
  `IncompatibleResumeError` (`resume.incompatible`) and the execution stays paused; recovery leaves
  such a root to an instance of a compatible version (logged once, `recovery.incompatible`).
- So a rolling deploy works as: new instances start next to the old ones; old ones finish or pause
  their executions and stop gracefully; executions the policy refuses wait for an instance of their
  version. A workflow's name is unique in one application (`[application.duplicate-workflow]`): two
  versions of one workflow do not run side by side in one application — keep the old version
  deployed until its paused executions are answered, or accept them with the policy.
- Resolved pause records are kept `retention.pauseRecords` (default `hours(24)`), then removed by the
  sweep: a late answer is `PauseClosedError` within it (`NotPausedError` is the thread-level miss),
  `UnknownPauseError` after. `Pending` is never
  removed.

## Execution history: `retention.executionRecords` and `agboss executions export`

Nothing of an execution is kept beyond its thread's turns unless the application says how long:
`@Application({ retention: { executionRecords: hours(24 * 30) } })`. Then every **root** execution's
`ExecutionHistoryRecord` is saved in the `ExecutionHistoryRepository` — when its tree rests at a
pause (`ExecutionHistoryStatus.Paused`, no `endedAt`) and when it ends (`Finished`, `Failed` or
`Cancelled`, with its `error`) — and the recovery sweep removes it once it ended longer ago than the
retention (a paused one is never removed). A record is the execution's `ExecutionRecord` (path,
scope, spend, children, pauses and who answered them, undo actions, `toolCalls`, `steps`, `origin`)
with who and what it was: `executionId`, `rootExecutionId`, `threadId`, `tenantId`, `application`
(name, version, instance), `workflow` (with its `configHash`), `start` and `input`, `finish` and
`output`, `startedAt` / `endedAt` on the `Clock`, and the `contexts` values. It is **masked like the
execution's traces**: the application's and the workflow's PII policies, a context field marked
`sensitive` hidden — a record never holds what a trace would not show. A save that fails is a
warning in the log (`execution-history.failed`), never the execution's failure; work handed over
(a lost lease, the app's stop) saves nothing — the next holder does.

On the built-in in-memory store it warns `[application.in-memory-execution-history]` (another
instance and the CLI do not see it); a durable `@DatabaseStorage` keeps it. Export it without running anything — the application's stores opened, no workflow built, no
sweep:

```
npx agboss executions export --env prod --tenant acme --since 2026-10-16 --out hub/records/acme.jsonl
npx agboss executions export --env prod --all-tenants --out hub/records/all.jsonl
```

One masked record per line, oldest start first, each `{ "kind": "agboss.execution-record",
"schema": 1, …record }`. A tenant is always named (`--tenant <id>`) or every tenant explicitly
(`--all-tenants`) — neither or both is `records.tenant-required` (exit 2); `--since` / `--until`
take an ISO 8601 date or time (records started in `[since, until)`); an application without
`retention.executionRecords` is `records.not-kept` (exit 3).

## The Mesh Hub: `agboss hub show`

Many applications' files form one picture of the mesh — no project, no application assembled, no
network. Each service's CI saves what it has; a platform repo reads the folder:

```
npx agboss describe --json > hub/desk-application/describe.json
npx agboss eval run --suite refunds-eval-suite --runs 5 --env eval --report hub/desk-application/refunds.run.json
npx agboss executions export --env prod --tenant acme --since 2026-10-16 --out hub/desk-application/records/acme.jsonl
npx agboss hub show hub/ --html .artifacts/mesh.html
```

- Inputs are files and folders only (a folder's `*.json` / `*.jsonl`, any depth), each known by its
  own marker: a `describe --json` envelope (`command: "describe"`), a run artifact (`kind:
"agboss.eval-run"`), an export (`kind: "agboss.execution-record"` per line). Anything else, or a
  newer schema, is `hub.input-schema` naming the file (and the line); two snapshots of one
  application version `hub.duplicate-application`; a missing path `hub.input-not-found` (all exit 3).
- The page (`--html`, one self-contained file in the eval report's shell: inline style and script by
  hash, no request — share it behind your own SSO) shows the **mesh graph** (each application, solid
  when a snapshot describes it, dashed when only records or runs name it), the **observed edges** — a
  caller's `toolCalls[].remote` and a receiver's `origin`, one call counted once by its step's
  `idempotencyKey` (never by tenant) — and a card per application: its workflows with their agents,
  routers, actions, child workflows, tools and MCP servers, its pause targets and channels, and its **health from
  its files only**: executions, failure rate, p95 duration, spend and spend per day from its records,
  the `limit.*` / `mesh.*` codes they failed with, and the latest run of each eval suite (pass^k,
  pass@k, unstable). Nothing live: probes stay the orchestrator's (`app.checkReadiness()`).
- **Execution trees across applications**: each tree that crosses applications, stitched from the
  exports by each receiver's `origin` — a record is a child of the execution whose `executionId` is
  `origin.executionId` (a root's or one of its children's), under the call whose step
  `idempotencyKey` is `origin.step.idempotencyKey`; never by tenant. A call whose receiver exported
  nothing is a stub (`billing-application · b1 (not exported)`), not an error; a receiver whose
  caller's record holds no such call is a root of its own, "called by" its caller. `--json` lists
  each tree's root, applications, executions and stubs.
- **The crystallization radar**: every model step (an agent or router with model calls) of the
  records, per application, workflow and step, ranked by **spend × stability** — stability is the
  share of the most frequent `steps[].decision` among the calls with the same `inputHash`, over the
  inputs seen at least twice. A **candidate** to turn into code (`DecidedBy.Code`, an `@Action`) has
  at least 50 calls, stability ≥ 0.95 and, where its workflow has eval runs, pass^k on every case of
  their latest; each row names its calls, spend, stability, pass^k and the executions behind it.
- **Blast radius & federation**: every contract a snapshot declares (`application.contracts`, an
  `@A2AAgent` or an `@McpServer` tool with a target) is a **declared edge**, consumer → producer —
  dashed in the graph when no record shows a call, a producer no snapshot describes a dashed box
  ("producer not among the inputs"). The problems are `agboss check --federation`'s own: the hub
  calls the same `checkFederation` over the newest snapshot of every application, so it lists the
  same `[federation.incompatible-schema]` / `[federation.missing-target]` with the same blast radius
  (the consumer's workflows and tools), and draws a broken contract red. Beside them, each
  application whose latest eval run lost pass^k with its callers — by a declared contract and by
  calls the records saw. A snapshot from an agboss without `contracts` is named, never guessed.
- **Served**: `npx agboss hub ui hub/ [--port 4318]` — the same files on 127.0.0.1 behind the token it
  prints, on `eval ui`'s server and rules (its own `Host` only, no CORS, read-only — GET and HEAD),
  read again on every request: the page, `/records` (every export's executions searched by
  application, workflow, status, a start window and a text in an id, a page at a time) and the JSON
  API `/api/mesh`, `/api/applications/<name>`, `/api/trees/<rootExecutionId>`, `/api/records?…`,
  `/api/radar`, `/api/blast-radius`. It is for one person on their own machine; share the static page instead.
- Above 16 MB the page is refused (`hub.report-too-large`): export a shorter period. Without
  `--html` it prints the summary; `--json` gives the applications, the inputs, the observed and declared edges, the trees, the
  radar and the federation's problems.

## Your own store and application repositories

Every class with a direct database connection or store contract lives in `repositories/<name>.repository.ts`
(never in `services/`). Keep SQL DDL in `sql/<name>.sql` files, define table schemas in
`schemas/<name>.schema.ts` using a typed ORM / query builder (such as Drizzle ORM), and never build
queries with string interpolation (`SELECT … ${clause}`).

A repository of the project's own tables injects `SqliteConnection` (of `@agboss/core/stores`: the
application's SQLite storage driver provides it, one connection for the stores and your tables) and
uses its `database` (a `node:sqlite` `DatabaseSync`) — never an internal helper of `@agboss/core`.
The repository is a service — in the workflow's `providers` (or the application's `services`). Its
DDL is a `.sql` file read once, applied by `ensureSchema`; its statements take `?` parameters; a write
transaction is `sqliteConnection.transaction(() => …)` — synchronous, no `await` inside, so two instances
on one event loop (`testWith(App, { instances: 2 })`) never wait on each other's open lock. A write that
must commit with a fenced effect uses `sqliteConnection.requireTransaction()` inside the `execute` of
`Idempotency.runOnce`, never a transaction of its own:

```sql file=src/claims/sql/claim-notes.sql
CREATE TABLE IF NOT EXISTS claim_notes (
  idempotency_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  note TEXT NOT NULL
);
```

```ts file=src/claims/schemas/claim-note.schema.ts
// schemas/<name>.schema.ts — a table's row type (with Drizzle ORM: its sqliteTable and inferred types)
export interface ClaimNoteRow {
  readonly claimId: string;
  readonly note: string;
}
```

```ts file=src/claims/repositories/claim-notes.repository.ts
import { readFileSync } from "node:fs";
import { Injectable } from "@agboss/core";
import { SqliteConnection } from "@agboss/core/stores";
import type { ClaimNoteRow } from "../schemas/claim-note.schema.js";

@Injectable({ deps: [SqliteConnection] })
export class ClaimNotesRepository {
  private readonly schema: string = readFileSync(new URL("../sql/claim-notes.sql", import.meta.url), "utf8");

  constructor(private readonly sqliteConnection: SqliteConnection) {}

  /** Saves the note once per step: a retried or recovered step's second write changes nothing. */
  saveOnce(idempotencyKey: string, row: ClaimNoteRow): boolean {
    this.sqliteConnection.ensureSchema("claim-notes", this.schema);
    return this.sqliteConnection.transaction(() => {
      const written = this.sqliteConnection.database
        .prepare("INSERT OR IGNORE INTO claim_notes (idempotency_key, claim_id, note) VALUES (?, ?, ?)")
        .run(idempotencyKey, row.claimId, row.note);
      return Number(written.changes) === 1;
    });
  }
}
```

The action or tool that calls it passes `executionContext.step.idempotencyKey`. With a typed ORM
such as Drizzle ORM the same rules hold — its table in `schemas/`, its queries in the repository —
and a write transaction stays synchronous: an async driver over `DatabaseSync`
(`drizzle-orm/sqlite-proxy`) must not hold a transaction open across an `await`.

A store of your own is a **storage driver**: `defineStorageDriver({ role, backend, describes, settings,
providers, … })` (of `@agboss/core/stores`) returns what `@DatabaseStorage({ driver })` takes, with the
store classes — each `extends` its contract — in its `providers`, as `PostgresDriver`, `MongoDriver` and
`RedisDriver` do; a driver with a `migrate` is what `npx agboss migrate db` runs. A test replaces one
store of an application with `testWith(App, { services: [MyLeaseRepository] })`. A SQLite-based store takes
its base's `deps` first — `SqliteConnection`, `Clock`, `ApplicationContext` (and `IdGenerator` for the records) —
and a lease store hands back an `ExecutionLease`.

An implementation over another store keeps every operation atomic, takes every time value from the
framework (durations as parameters; a lease or fenced store reads now from its `StoreClock` — the
database's time when its `source` is `Database` — never from the instance's `Clock`), and implements
`ping()` — one fast round trip that readiness calls. It gives back every text and JSON value it is
handed unchanged — a model's or a tool's answer may hold a NUL character (U+0000), which
PostgreSQL's `jsonb` and `text` reject: keep JSON as text there (`\u0000` is an escape in it), as
the core's SQLite record store keeps free text (#521; each contract suite has a NUL case). A ledger
(#817) takes `LedgerEntry` values only — calls `assertLedgerEntries(entries)` first
(`CostLedgerEntryInvalidError` for a JS caller's record without `ledgerId`, a `madeAt` `Date` or a
`costUsd` amount), refuses what `expiredEntriesOf(entries, prunedBefore, isHeld)` names, adds what
`unrecordedEntriesOf(entries, isNew)` keeps (dates are `Date`, to the millisecond) and sums it with
the core's `totalCost(entries)` (`Usd`); `deleteByMadeAtBefore(cutoff)` prunes. A store imports
what it is written with from `@agboss/core/stores` (#890): the contracts, every type they name, the
rows at its boundary and the core's store helpers (`assertLedgerEntries`, `assertEffectName`,
`replayedFromOf`, `remainingOf`, …) — an application's root entry has none of them.

It proves that with the core's own contract suites (#481), published as
`@agboss/core/testing/contracts` — one function per contract (`executionLeaseContract`,
`childExecutionQueueContract`, …, `checkpointSaverContract`), the very cases the in-memory and SQLite
stores pass. A `ContractTarget` says how to build one instance's store from its `StoreInstanceContext` (the
suite's `VirtualClock`, `instanceId`, `application`), `reset()` empties the backing store before each
case and `close(store)` runs after it; every case builds two instances on one backing store:

<!-- snippet-context
import { ExecutionLeaseRepository, type ApplicationContext, type Clock } from "@agboss/core";
declare class Pool { query(sql: string): Promise<void>; }
declare const pool: Pool;
declare const PostgresExecutionLeaseRepository: new (
  pool: Pool,
  clock: Clock,
  applicationContext: ApplicationContext,
) => ExecutionLeaseRepository;
-->

```ts
// tests/postgres-lease.contract.test.ts — "lease contract (PostgreSQL)", a case per rule
import { executionLeaseContract } from "@agboss/core/testing/contracts";

executionLeaseContract({
  name: "PostgreSQL",
  instance: (context) => new PostgresExecutionLeaseRepository(pool, context.clock, context.application),
  reset: () => pool.query("TRUNCATE execution_leases"),
});
```

## Testing it

```ts file=tests/claims.application.test.ts
import { expect } from "vitest";
import { HealthStatus } from "@agboss/core";
import { replyWith, testWith } from "@agboss/core/testing";
import { ClaimsApplication } from "../src/claims.application.js";
import { ClaimAssessorAgent } from "../src/claims/agents/claim-assessor/claim-assessor.agent.js";
import { ClaimAssessmentDto } from "../src/claims/dto/claim-assessment.dto.js";
import { ClaimWorkflowStart } from "../src/claims/workflows/claim/claim.workflow-start.js";

const test = testWith(ClaimsApplication); // the storage's path is :memory: in the vitest config
const twoInstances = testWith(ClaimsApplication, { instances: 2 });

test("ready on its stores; a closing instance is not live", async ({ app }) => {
  await app.ready();
  expect((await app.checkReadiness()).status).toBe(HealthStatus.Healthy);

  await app.close();

  expect((await app.checkLiveness()).status).toBe(HealthStatus.Unhealthy);
});

twoInstances("two instances share one set of stores", async ({ app, apps, mockModel }) => {
  mockModel(ClaimAssessorAgent).thenReturn(replyWith(ClaimAssessmentDto, { assessment: "Covered." }));

  const result = await app.execute(ClaimWorkflowStart, { text: "a broken window" }); // apps[0]

  expect(result.output).toEqual({ assessment: "Covered." });
  expect(apps).toHaveLength(2);
  await expect(apps[1]?.checkReadiness()).resolves.toMatchObject({ status: HealthStatus.Healthy });
});
```

`testWith(App, { instances: 2 })` gives `apps` — two instances, each its own container, over one set
of stores and one `clock`: a pause resumed on the other instance, a lease taken over after
`await clock.advance(seconds(31))`, a recovery at the next sweep. The in-memory defaults are shared
between the instances; SQLite stores are shared only through a file. Each instance opens its own
connection, and `:memory:` is one database per connection, so on `:memory:` the two instances see
nothing of each other: a multi-instance test runs on a temp file (a storage with
`SqliteDriver.inMemory()` — one temporary file shared by every instance made from it, removed at
exit — or a path in the test's `env`).

## Pitfalls

- In-memory stores in production: pauses vanish on restart (`[application.in-memory-pauses]`),
  budgets count per instance (`[application.in-memory-cost-ledger]`).
- SQLite across machines: one file is one machine; several nodes need a networked storage driver (`PostgresDriver`, `MongoDriver`, with `RedisDriver` as the cluster).
- Holding a `node:sqlite` (`DatabaseSync`) `BEGIN IMMEDIATE` write lock across an `await` (for
  example through an async ORM proxy): when `testWith(App, { instances: 2 })` runs two instances on
  one Node.js event loop over one SQLite file, the sibling connection blocks synchronously inside
  `sqlite3_busy_timeout` and self-deadlocks with `SQLITE_BUSY`. Execute `BEGIN IMMEDIATE … COMMIT`
  synchronously in one JS turn without yielding microtasks inside the open write transaction.
- Trusting the lease to fence an external write: the framework fences only its own checkpoint
  writes. A step whose instance lost the lease sees `executionContext.signal` abort with
  `ExecutionLeaseLostError`, but a write it already sent to a database or a file still lands, and
  the instance that takes the tree over runs the step again. Make every external write go
  through `Idempotency` (`runOnce` for rows of the application's own database, `sendOnce` for a call
  that leaves the system): it keys the write by the step and fences it by the lease's token.
- `ChildPlacement.AnyWorker` across processes: a child queued in one process wakes that process's
  workers at once, never another's — other processes find it at their workers' sweep, every 30 s.
  A worker claims queued children while it has free step slots, so the first one to look may take a
  whole launch of siblings: bound it with `@Application({ executionLimits: { maxConcurrentSteps } })`. A `Running` child
  whose instance died is taken over by a live worker once its 30 s lease expires — automatically,
  only when the child queue and the leases are shared stores (one SQLite file, or a networked
  database storage with the `@ClusterStorage` beside it).
- Missing non-TypeScript assets in `dist/`: `tsc` does not copy `*.prompt.md` (a `prompt` path) or
  `sql/*.sql` files, so a compiled `node dist/…` in a container fails at start with
  `[prompt.missing-file]` — make the project's build copy every non-`.ts` file of `src/` next to its
  compiled module, and run that build in the image.
- A side effect without `step.idempotencyKey`: a recovered step runs again.
- `terminationGracePeriodSeconds` below `shutdownTimeout`: the platform kills the pod mid-drain.
- Expecting a new version to pick up an old paused execution: it is refused unless
  `onIncompatibleResume` says `ResumeDecision.Resume`.
