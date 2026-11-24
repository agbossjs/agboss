# 08 — Observability and tracing

Read this when you read what an execution did (`result`, `result.record`), write an observer (metrics,
audit, your own tracer), replace the framework's log, or send traces to Langfuse or another backend.

| You want                                          | Use                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| what one execution did, in code or a test         | the `ExecutionOutput` of `app.execute` / `app.resume`; `{ includeRecord: true }` for the full record |
| metrics, audit, alerts, your own tracer           | an observer class in `@Application({ observers })`                                                   |
| a trace of every step, model call and tool call   | `createApp(App, { tracerProvider })`: an OpenTelemetry provider or `LangfuseTracer`                  |
| the framework's own problems (recovery, failures) | its log through the application's `Logger`                                                           |
| the declarative spec the records join on          | `npx agboss describe --json` (`configHash`, each node's `promptHash` / `schemaHash`)                 |

## What an execution returns

`ExecutionOutput` — every call of `app.execute` / `app.resume` returns it:

| Field                                 | What                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `status`                              | `ExecutionStatus.Finished`, `Paused`, `Stopped` or `Cancelled`                                                                      |
| `output`, `finish`                    | the finish's DTO and its `ComponentRecord` (`{ name, kind, promptHash, schemaHash }`)                                               |
| `path`                                | the visited nodes in order (`critic-agent#2` for a copy)                                                                            |
| `spend`                               | `CostReport`: `totalUsd`, `calls`, tokens, `byCategory`, `byModel`, `byCaller`, `trace` (every call in order)                       |
| `executionId`, `threadId`, `tenantId` | the keys                                                                                                                            |
| `pending`                             | every waiting pause (`PendingPause`), when paused                                                                                   |
| `launches`                            | one `LaunchRecord` per joined launch: `items`, `taken`, each branch's `BranchStatus` and, under a quorum, `BranchVerdict`           |
| `children`                            | the child executions' records (`ChildExecutionRecord`: `ChildExecutionStatus`, start, finish, path, spend, own children and pauses) |
| `handledErrors`                       | the failures a side path took — `{ at, by, error }`                                                                                 |
| `compensations`                       | every undo that ran — `CompensationRecord` (reference 02, section 8)                                                                |
| `compacted`                           | what each compaction did before the execution                                                                                       |
| `traceUrl`                            | the tracing adapter's link, on every status, when its `traceUrl` builds one (`LangfuseTracer` with a `projectId`)                   |
| `record`                              | with `{ includeRecord: true }`: the `ExecutionRecord` below                                                                         |

`ExecutionRecord` — `path`, `scope` (every current value of the path scope: `ScopeValueRecord` with
`valueId`, `slot`, `producer`, `builtFrom`, the value), `outdatedValues`
(`OutdatedValueRecord`, each with its `OutdatedReason`), `lastError` (an `ErrorRecord`: `name`,
`code`, `message`, `lineage`, `cause`), `spend`, `children`, `compensations` and `pauses` — who
answered each resolved pause of the tree (`PauseAnswerRecord`: `pauseId`, `role`, `answerer`,
`answeredBy`, `responder` (deprecated alias of `answeredBy`), `resolution: PauseResolution.Decided | Replied | Withdrawn | Cancelled`, `askedAt`,
`resolvedAt`, the masked `decision`). The record, events, logs and traces are masked by the
application's and the workflow's PII policies.

## The worked example: metrics, audit and a log

The desk workflow, one component per file:

```ts file=src/desk/dto/desk-answer.dto.ts
import { Text } from "@agboss/core/dto";

export class DeskAnswerDto {
  @Text({ prompt: "the answer to send" })
  text!: string;
}
```

```ts file=src/desk/dto/desk-ticket.dto.ts
import { Text } from "@agboss/core/dto";

export class DeskTicketDto {
  @Text({ prompt: "the ticket's id" })
  ticketId!: string;
}
```

```ts file=src/desk/workflows/desk/desk.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "desk-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class DeskWorkflowStart {}
```

```ts file=src/desk/agents/desk/desk.agent.ts
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { DeskAnswerDto } from "../../dto/desk-answer.dto.js";

@Agent({
  name: "desk-agent",
  description: "Answers the customer",
  prompt: inline("Answer the customer in two sentences."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: DeskAnswerDto,
})
export class DeskAgent {}
```

```ts file=src/desk/actions/open-ticket.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { DeskAnswerDto } from "../dto/desk-answer.dto.js";
import { DeskTicketDto } from "../dto/desk-ticket.dto.js";

@Action({
  name: "open-ticket-action",
  description: "Opens a ticket for the answer",
  input: { answer: DeskAnswerDto },
  output: DeskTicketDto,
  deps: [ExecutionContext],
})
export class OpenTicketAction implements ActionHandler<OpenTicketAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: InputOf<OpenTicketAction>): Promise<OutputOf<OpenTicketAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return Promise.resolve({ ticketId: `${String(input.answer.value.text.length)}:${key}` });
  }
}
```

```ts file=src/desk/workflows/desk/desk.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { DeskTicketDto } from "../../dto/desk-ticket.dto.js";

@WorkflowFinish({ name: "desk-workflow-finish", description: "The ticket", output: DeskTicketDto })
export class DeskWorkflowFinish {}
```

```ts file=src/desk/workflows/desk/desk.workflow.ts
import { Workflow, onStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { OpenTicketAction } from "../../actions/open-ticket.action.js";
import { DeskAgent } from "../../agents/desk/desk.agent.js";
import { DeskAnswerDto } from "../../dto/desk-answer.dto.js";
import { DeskTicketDto } from "../../dto/desk-ticket.dto.js";
import { DeskWorkflowFinish } from "./desk.workflow-finish.js";
import { DeskWorkflowStart } from "./desk.workflow-start.js";

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    onStart(DeskWorkflowStart)
      .toAgent(DeskAgent)
      .toAction(OpenTicketAction)
      .toFinish(DeskWorkflowFinish),
  ],
  maxSteps: 2,
})
export class DeskWorkflow {}
```

```ts file=src/desk/services/metrics.service.ts
// your metrics client (Prometheus, StatsD, …) behind a service
import { Injectable } from "@agboss/core";

@Injectable()
export class MetricsService {
  increment(metric: string, labels: Readonly<Record<string, string>>): void {
    void metric;
    void labels;
  }

  observe(metric: string, value: number, labels: Readonly<Record<string, string>>): void {
    void metric;
    void value;
    void labels;
  }
}
```

```ts file=src/desk/observers/execution-metrics.observer.ts
// one instance, every execution of the application
import {
  Observer,
  ResumeReason,
  nameOf,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionRejectedEvent,
  type ExecutionResumeEvent,
  type ModelEndEvent,
} from "@agboss/core";
import { DeskAgent } from "../agents/desk/desk.agent.js";
import { MetricsService } from "../services/metrics.service.js";

@Observer({ deps: [MetricsService] })
export class ExecutionMetricsObserver {
  constructor(private readonly metricsService: MetricsService) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    const labels = { workflow: event.workflow.name, finish: event.finish.name, tenant: event.tenantId };
    this.metricsService.observe("execution_spend_usd", event.spend.totalUsd, labels);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    const code: string = event.error instanceof Error ? event.error.name : "unknown";
    this.metricsService.increment("execution_failed", { workflow: event.workflow.name, code });
    // the undo actions that ran for it, side paths' first, then the automatic ones
    for (const undo of event.compensations)
      this.metricsService.increment("execution_undo", { action: undo.compensator.name, status: undo.status });
  }

  onExecutionRejected(event: ExecutionRejectedEvent): void {
    // refused before an execution started: no executionId, a message without input values
    this.metricsService.increment("execution_rejected", { operation: event.operation, code: event.code });
  }

  onExecutionResume(event: ExecutionResumeEvent): void {
    if (event.reason === ResumeReason.Recovered)
      this.metricsService.increment("execution_recovered", { workflow: event.workflow.name });
  }

  onModelEnd(event: ModelEndEvent): void {
    if (event.step.component.name !== nameOf(DeskAgent)) return; // filter by name, never by nodeId
    this.metricsService.observe("model_tokens", event.usage.totalTokens, { model: event.model });
  }
}
```

```ts file=src/desk/observers/compensation-audit.observer.ts
// the automatic undo, around the undo action's own events
import {
  CompensationStatus,
  Observer,
  type CompensationEndEvent,
  type CompensationStartEvent,
} from "@agboss/core";

@Observer()
export class CompensationAuditObserver {
  onCompensationStart(event: CompensationStartEvent): void {
    // event.step is the undo action's step (its key: the undone step's key + ":compensation")
    console.info(`undoing ${event.compensated.component.name} (${event.reason})`, event.step.idempotencyKey);
  }

  onCompensationEnd(event: CompensationEndEvent): void {
    if (event.status === CompensationStatus.Failed)
      console.warn(`${event.compensated.component.name} not undone: ${event.error?.message ?? ""}`);
  }
}
```

```ts file=src/desk/infrastructure/json.logger.ts
// the framework's own log, one JSON line per entry
import { Injectable, LogLevel, Logger, type LogEntry } from "@agboss/core";

@Injectable()
export class JsonLogger extends Logger {
  write(entry: LogEntry): void {
    const line: string = JSON.stringify({
      time: entry.time.toISOString(),
      level: entry.level,
      code: entry.code, // stable: execution.recovered, observer.failed, app.step-still-running, …
      message: entry.message,
      executionId: entry.executionId,
      tenantId: entry.tenantId,
    });
    if (entry.level === LogLevel.Error) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}
```

```ts file=src/desk/budgets/application-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}
```

```ts file=src/desk/budgets/tenant-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}
```

```ts file=src/desk/budgets/execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}
```

```ts file=src/desk.application.ts
import { Application, EmptyEnvironment } from "@agboss/core";
import { ApplicationDailyBudget } from "./desk/budgets/application-daily.budget.js";
import { ExecutionBudget } from "./desk/budgets/execution.budget.js";
import { TenantDailyBudget } from "./desk/budgets/tenant-daily.budget.js";
import { JsonLogger } from "./desk/infrastructure/json.logger.js";
import { CompensationAuditObserver } from "./desk/observers/compensation-audit.observer.js";
import { ExecutionMetricsObserver } from "./desk/observers/execution-metrics.observer.js";
import { MetricsService } from "./desk/services/metrics.service.js";
import { DeskWorkflow } from "./desk/workflows/desk/desk.workflow.js";

@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  observers: [ExecutionMetricsObserver, CompensationAuditObserver], // the only place observers go
  providers: [JsonLogger, MetricsService], // a Logger is infrastructure: listed in the application
})
export class DeskApplication {}
```

## Observers

- **Registered, not discovered**: only classes in `@Application({ observers })` are called — never in
  `@Workflow`. Each is an `@Observer({ name?, workflows?, agents?, deps? })` class, one instance each (created by the
  container), called for every execution of the application, child executions included — within its
  `workflows` / `agents` filter, so a hook needs no `if (event.workflow.name !== …) return`.
- **One method per hook** (no `implements`; `ExecutionObserver` is the type of all of them, each optional), each with a typed, plain-data event (no class, no internal state):

| Hooks                                                                                                                              | Event                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onExecutionStart`                                                                                                                 | once per execution — a resume does not start it again                                                                                                                      |
| `onExecutionPause` / `onExecutionResume`                                                                                           | `pending` / `reason: ResumeReason.Answered \| Recovered \| Expired`, `decision`, `answeredBy`                                                                              |
| `onExecutionEnd`                                                                                                                   | once, at a finish: `finish`, `output`, `spend`                                                                                                                             |
| `onExecutionError`                                                                                                                 | a failure: `error`, `compensations`                                                                                                                                        |
| `onExecutionCancel`                                                                                                                | a cancel (running or paused): `compensations`, `spend`                                                                                                                     |
| `onExecutionStop`                                                                                                                  | a stop: `reason`, `spend`                                                                                                                                                  |
| `onExecutionRejected`                                                                                                              | refused before an execution: `operation: ExecutionOperation`, `threadId?`, `tenantId`, `code`, `message`                                                                   |
| `onAgentRetry`                                                                                                                     | an agent corrects itself (`AgentRetryEvent`): `agent`, `reason: AgentRetryReason.InvalidAnswer \| InvalidToolInput \| JudgeRejected`, `attempt`, `maxAttempts`, `feedback` |
| `onAgentStart` / `onAgentEnd`, `onRouterStart` / `onRouterEnd`, `onActionStart` / `onActionEnd`                                    | a node's visit                                                                                                                                                             |
| `onToolStart` / `onToolEnd`                                                                                                        | `tool`, `agent?`, `input` / `output`, `isResultTruncated`                                                                                                                  |
| `onModelStart` / `onModelEnd`                                                                                                      | an agent's model call: `model`, `caller`, `usage` (`TokenUsage`), `costUsd`                                                                                                |
| `onRagStart` / `onRagEnd`, `onGuardrailStart` / `onGuardrailEnd`, `onChannelStart` / `onChannelEnd`, `onJudgeStart` / `onJudgeEnd` | as named                                                                                                                                                                   |
| `onCircuitStateChange`                                                                                                             | a provider's breaker changed state: `provider`, `from`, `to`, `at` (the application's, no workflow filter)                                                                 |
| `onValuesOutdated`                                                                                                                 | one per outdating cascade: `trigger`, `outdated` (no DTO values)                                                                                                           |
| `onLaunchItemsTruncated`                                                                                                           | a per-item launch dropped items: `launch`, `items`, `maxItems`                                                                                                             |
| `onQuorumDecided`                                                                                                                  | once per quorum: `launch`, `isReached`, `branches`, `group`                                                                                                                |
| `onCompensationStart` / `onCompensationEnd`                                                                                        | an automatic undo: `compensated`, `reason` / `status`, `error`                                                                                                             |

- **Every event** (`ExecutionEvent`) has `executionId`, `parentExecutionId` (a child's parent),
  `rootExecutionId`, `threadId`, `tenantId` and `workflow` (`WorkflowRecord`: `name`, `version`,
  `startedVersion`, `configHash`). A **node event** (`NodeEvent`) adds `step` (`StepRecord`:
  `component`, `nodeId`, `visitNumber`, `copyNumber`, `itemIndex`, `idempotencyKey`, `callId`,
  `toolLoopIteration`, `validationAttempts`, `compensates`).
- **Filter** in the decorator: `@Observer({ workflows: [DeskWorkflow], agents: [DeskAgent] })`; app-level
  events (no workflow or agent) reach only observers without that filter. By name: `nameOf(Class)`.
- An observer without `@Observer`, with no hook or a misspelled one, or with a repeated name fails
  assembly (`[observer.not-an-observer]`, `[observer.no-hooks]`, `[observer.unknown-hook]`,
  `[observer.duplicate-name]`); one that throws is a warning in the log
  (`observer.failed`) and never fails the execution.
- Not model calls of an agent (no `onModelStart` / `onModelEnd`): a model arbiter's, a reply
  interpreter's, a guardrail's, a compaction's — their cost is in `spend` under `arbiter:<name>`,
  `reply-interpreter:<name>`, `guardrail:<name>`, `compaction:<name>`.

## Join keys

Every event, record and trace joins the declarative snapshot of `npx agboss describe --json`:
`workflow.configHash` (the workflow's fingerprint — config, flow and every text its models read; also
in `executionContext.workflow`), `step.component.kind` / `promptHash` / `schemaHash` (one entry of
`nodes[]`), `nodeId` + `copyNumber` + `itemIndex` (a branch in `result.launches`). Store them with
your metrics to tell which version of a prompt produced what.

## The framework's log

The framework writes through the application's `Logger` — infrastructure like `Clock`: the built-in
`ConsoleLogger` (one line per entry on stderr) unless `@Application({ providers })` lists a class
that `extends Logger` (`write(entry: LogEntry)`; `LogEntry`: `level: LogLevel`, `code`, `message`,
`time`, `executionId?`, `tenantId?`). In tests it is silent unless listed.

- **At start, once**: what started and the worst case of one call of each start — only what the
  decorators say (no `maxSpend()`), then the assembly warnings (`[application.in-memory-cost-ledger]`,
  `[application.in-memory-pauses]`; also in `app.warnings`).
- **While running, only problems**: `LogLevel.Warn` — `execution.recovered`, `recovery.incompatible`,
  `observer.failed`, `compensation.step-still-running`, `pause.notice-failed`,
  `pause.notice-recipient-unknown`, `pause.expiry-handler-failed`, `pause.expiry-failed`, `pause.working-calendar-failed`, `pause.reassign-send-failed`, `pause.resend-failed`; `LogLevel.Error` — `pause.notice-dead`, `pause-timers.failed`,
  `recovery.failed`, `app.close-failed`, `compensation.late-undo-failed`. One execution's details are
  its trace, a tenant's spend the cost ledger.

## Tracing

- **`createApp(App, { tracerProvider })`** turns tracing on; without it nothing is traced and
  nothing changes. The framework emits vendor-neutral OpenTelemetry spans: one per node, named by
  its kind and name, the agent's model requests and tool calls inside; a child workflow is a nested
  run under its parent's step; the first span of a run carries `session.id` (the thread),
  `agboss.tenant.id` and `agboss.run.id`. Every value is masked by the workflow's PII policies
  (a child's: by its ancestors' too) **before** it is set on a span — an external provider never
  sees an unmasked value. Decision-model calls (Jev) are not LangChain calls: their cost is in
  `spend`, not in the trace.
- **Your own provider** (`TracerProvider` of the OpenTelemetry SDK): yours — `app.close()` flushes it,
  you shut it down. The framework never registers a global provider.
- **A `TracingAdapter`** (`{ tracerProvider, traceUrl?(ctx), forceFlush?(), shutdown?() }`) is the
  application's: `app.close()` flushes and shuts it down, and `ExecutionOutput.traceUrl` is its
  `traceUrl(ctx)` (`ctx`: `TraceLinkContext` — workflow, thread, run, tenant).
- **Langfuse**: `@agboss/langfuse` — `new LangfuseTracer({ publicKey, secretKey, baseUrl, projectId })`
  as the `tracerProvider`; `LangfuseTracer.fromEnv()` reads the `LANGFUSE_*` variables. `@agboss/core`
  itself reads none of them.

## Reading it in a test

```ts file=tests/desk/workflows/desk/record.test.ts
import { expect } from "vitest";
import { ExecutionStatus } from "@agboss/core";
import { replyWith, testWith } from "@agboss/core/testing";
import { DeskApplication } from "../../../../src/desk.application.js";
import { OpenTicketAction } from "../../../../src/desk/actions/open-ticket.action.js";
import { DeskAgent } from "../../../../src/desk/agents/desk/desk.agent.js";
import { DeskAnswerDto } from "../../../../src/desk/dto/desk-answer.dto.js";
import { DeskWorkflowFinish } from "../../../../src/desk/workflows/desk/desk.workflow-finish.js";
import { DeskWorkflowStart } from "../../../../src/desk/workflows/desk/desk.workflow-start.js";

const test = testWith(DeskApplication);

test("the record shows the path, the scope and the spend", async ({ app, mockLlm }) => {
  mockLlm(DeskAgent).thenReturn(replyWith(DeskAnswerDto, { text: "We are on it." }));

  const result = await app.execute(DeskWorkflowStart, { text: "my order is late" }, { includeRecord: true });

  expect(result.status).toBe(ExecutionStatus.Finished);
  expect(result).toFollowPath([DeskWorkflowStart, DeskAgent, OpenTicketAction, DeskWorkflowFinish]);
  expect(result.record?.scope.map((value) => value.slot)).toContain("DeskAnswerDto");
  expect(result.spend.calls).toBe(1);
  expect(result.compensations).toEqual([]);
});
```

## Pitfalls

- An observer in `@Workflow` or found by a decorator scan — list it in `@Application({ observers })`.
- Parsing `nodeId` (`critic-agent#2`) to find a component — use `step.component.name`, `copyNumber`,
  `itemIndex`.
- Doing slow I/O in a hook — it runs on the execution's path; buffer it in a service.
- Logging DTO values from `scope`: they are the real values; events, logs and traces are masked, the
  scope is not.
- Expecting traces from `testWith`: tests run offline and give no `tracerProvider`.
