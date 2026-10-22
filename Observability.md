# Observability

Observers see an application's executions: their start, pause, resume, end and failure, the
requests refused before an execution, and the node events — agent, router, tool, model, knowledge
base, guardrail, action, channel and judge start / end, outdated values, truncated
launches. They are registered, not discovered: only classes listed in
`@Application({ observers: [...] })` are called (#261) — never in `@Workflow`; one instance each,
for every execution of the application, child executions included. Tracing to Langfuse is built in
([Tracing](Tracing)); observers are for everything else (metrics, your own tracer, audit). What the
framework itself writes is its [log](#the-frameworks-log).

## Every event

One event object per hook, plain data — never the framework's internal state (the full record of
an execution is `result.record`). Every execution event extends `ExecutionEvent`:

| Field               | What                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `executionId`       | unique per execution, the same after a resume (`result.executionId`)                |
| `parentExecutionId` | the execution that launched this child (#263); `undefined` at the root        |
| `rootExecutionId`   | the root's id; the execution's own at the root                                |
| `threadId`          | the conversation                                                              |
| `tenantId`          | the tenant it works for (`"default"` when it names none)                      |
| `workflow`          | a `WorkflowRecord` `{ name, version, startedVersion, configHash }` — no class |

A node event (`NodeEvent`) adds `step`, a `StepRecord` — the serialized `executionContext.step`:
`component` (a `ComponentRecord`, no class), `nodeId` (`critic-agent#2` for a copy), `visitNumber`,
`copyNumber`, `itemIndex`, `idempotencyKey`, `callId` (during a tool call), `toolLoopIteration`,
`validationAttempts` ([Join keys](#join-keys) below). An observer interested
in one workflow or component filters by name, taken with `nameOf(C)` (any AGBoss-decorated class;
an undecorated one throws `ComponentError`): `event.workflow.name === nameOf(SupportWorkflow)`,
`event.step.component.name === nameOf(CriticAgent)` — never by parsing `nodeId`.

### Join keys

Every event, record and trace joins the declarative snapshot of [`agboss describe
--json`](CLI#the-declarative-snapshot-268) without generating code back into TypeScript (#268 S92 /
S93) — for analytics over Langfuse and `ExecutionRecordRepository`, OpenAPI generators, or checking
a checkpoint against a release:

| Key                       | Where                                                       | What                                                                                                   |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `configHash`              | `event.workflow`, `executionContext.workflow`, records      | the one key of the workflow: the fingerprint of its config, flow and every text its models read         |
| `component.kind`          | `event.step.component`, `finish`, errors, handled errors    | `ComponentKind`: `WorkflowStart`, `Agent`, `Router`, `Action`, `WorkflowFinish`, `Workflow`, `Budget`, … |
| `component.promptHash`    | the same                                                    | the hash of what its model is told (an agent's instructions, a model router's prompt and routes); `undefined` without a model |
| `component.schemaHash`    | the same                                                    | the hash of what it reads and writes (`input` fields, `output`), each DTO by its JSON Schema's hash; `undefined` when it declares neither |
| `step.toolLoopIteration`  | `event.step`, `executionContext.step`, `record.pauses[].step` | an agent's model call in the visit, from 1 — during the call and the tool calls its move asks for; `undefined` elsewhere |
| `step.validationAttempts` | the same                                                    | the step's answers and tool arguments that failed validation so far, each sent back to the model        |
| `visitNumber`, `copyNumber`, `itemIndex` | `event.step`                                 | the visit, the copy and the item of a launch (#273)                                                    |

A branch's outcome — `BranchStatus` and, under a quorum, `BranchVerdict` — is in `result.launches`
and `onQuorumDecided`, joined by `nodeId`, `copyNumber` and `itemIndex`. `toolLoopIteration` is not
part of `idempotencyKey` (#335): the key's format is unchanged.

```ts
import { Injectable, type ModelEndEvent, type OnModelEnd } from "agboss";

@Injectable()
export class JoinKeyLog implements OnModelEnd {
  onModelEnd(event: ModelEndEvent): void {
    const { configHash } = event.workflow; // describe --json: workflows[].configHash
    const { name, promptHash, schemaHash } = event.step.component; // workflows[].nodes[]
    const iteration = event.step.toolLoopIteration; // 1, 2, … within the agent's visit
    console.info(configHash, name, promptHash, schemaHash, iteration, event.calculatedCost);
  }
}
```

## The hooks

Each hook is its own interface with a typed payload (root entry `agboss`):

| Hook interfaces                           | Payload                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `OnExecutionStart`                        | `ExecutionStartEvent` (the common fields)                                                 |
| `OnExecutionEnd`                          | `ExecutionEndEvent` (`finish`: a `ComponentRecord`, `spend`)                              |
| `OnExecutionPause` / `OnExecutionResume`  | `ExecutionPauseEvent` (`pending`) / `ExecutionResumeEvent` (`reason`, `decision`, `answeredBy`)|
| `OnExecutionError`                        | `ExecutionErrorEvent` (`error`)                                                           |
| `OnExecutionRejected`                     | `ExecutionRejectedEvent` (`operation`, `threadId?`, `tenantId`, `code`, `message`)        |
| `OnAgentStart` / `OnAgentEnd`             | `AgentStartEvent` / `AgentEndEvent`                                                       |
| `OnRouterStart` / `OnRouterEnd`           | `RouterStartEvent` / `RouterEndEvent`                                                     |
| `OnToolStart` / `OnToolEnd`               | `ToolStartEvent` (tool, agent, arguments) / `ToolEndEvent` (`update`, `isResultTruncated` — #336) |
| `OnModelStart` / `OnModelEnd`             | `ModelStartEvent` / `ModelEndEvent` (model, usage, cost)                                  |
| `OnRagStart` / `OnRagEnd`                 | `RagStartEvent` / `RagEndEvent`                                                           |
| `OnActionStart` / `OnActionEnd`           | `ActionStartEvent` / `ActionEndEvent`                                                     |
| `OnGuardrailStart` / `OnGuardrailEnd`     | `GuardrailStartEvent` (`input`: `side`, `element`, the masked `text`) / `GuardrailEndEvent` (`update`: `isBlocked`, `probability`) |
| `OnChannelStart` / `OnChannelEnd`         | `ChannelStartEvent` / `ChannelEndEvent`                                                   |
| `OnJudgeStart` / `OnJudgeEnd`             | `JudgeStartEvent` / `JudgeEndEvent`                                                       |
| `OnValuesOutdated`                        | `ValuesOutdatedEvent` (step, trigger, outdated — [below](#outdated-values))               |
| `OnLaunchItemsTruncated`                  | `LaunchItemsTruncatedEvent` (step, launch, items, maxItems — [below](#parallel-launches)) |
| `OnQuorumDecided`                         | `QuorumDecidedEvent` (step, launch, isReached, branches, group — [below](#quorums))       |

`onExecutionStart` fires once per execution, at `execute` — a resume does not start it again, so
the count of starts is the count of executions. One that pauses (an approval on a channel) emits
`onExecutionPause` (`event.pending`: every pause it waits for, when nothing else can move — [Pauses](Pauses)); `app.resume` emits `onExecutionResume`
(`event.decision`, `event.reason`: `ResumeReason.Answered`, or `ResumeReason.Recovered` when
[recovery](Several-instances#recovery) continues an interrupted one). `onExecutionEnd` fires once,
when the execution ends at a finish — also after a resume; it has no status: a pause is
`onExecutionPause`, a failure `onExecutionError`. Cancelling a paused execution (`app.cancel`) emits
`onExecutionError` with `ExecutionCancelledError`. A running execution cancelled from another
instance (#360) emits it once, on the instance that moves it when it stops — or, when the request
ends the tree without a pass (a resume or a recovery found it), on the instance that ended it
([Several instances → Cancelling from any instance](Several-instances#cancelling-from-any-instance)). One approval: start → pause → resume → end.

## Refused requests

A request the app refuses before an execution starts or is located emits `onExecutionRejected` and
is still thrown to the caller. `ExecutionRejectedEvent` carries the `operation`
(`ExecutionOperation.Execute`, `Resume` or `Cancel`, #269), the `threadId` the request named (absent
for an `execute` without one), the `tenantId` it named (`"default"` otherwise), the error's stable
`code` and a `message` without the input values. It never carries an `executionId`: no execution
started, and another owner's is not revealed.

| Refusal                                                    | Operation                     | `code`                 |
| ---------------------------------------------------------- | ----------------------------- | ---------------------- |
| a thread of another owner (`ThreadOwnerError`)             | `Execute`, `Resume`, `Cancel` | `run.thread-owner`     |
| nothing paused on the thread (`NotPausedError`)            | `Resume`                      | `run.not-paused`       |
| an unknown thread of the tenant (`UnknownThreadError`)     | `Execute`, `Cancel`           | `run.unknown-thread`   |
| a class that is not a start of the workflow                | `Execute`                     | `workflow.not-a-start` |
| invalid start input or context values (`DtoValidationError`) | `Execute`                   | `dto.invalid`          |
| an exhausted budget before the first step                  | `Execute`                     | `limit.budget`         |
| the app is stopping (`ApplicationStoppingError`)           | `Execute`, `Resume`           | `app.stopping`         |

For invalid input the message names the DTO and its fields (`invalid Voucher at code`), never
their values; the thrown error keeps the full message. A resume refused after a deploy
(`IncompatibleResumeError`) is not a refused request: the paused execution is known, so it is an
`onExecutionError` with its `executionId` and thread, and it stays paused — resumable by an app
whose `onIncompatibleResume` policy accepts it.

```ts
import {
  ExecutionOperation,
  Injectable,
  type ExecutionRejectedEvent,
  type OnExecutionRejected,
} from "agboss";

@Injectable()
export class Audit implements OnExecutionRejected {
  onExecutionRejected(event: ExecutionRejectedEvent): void {
    const what = event.operation === ExecutionOperation.Execute ? "a new execution" : event.operation;
    console.warn(`${what} refused for ${event.tenantId}: ${event.code}`);
  }
}
```

## Outdated values

A write that renews a slot of the path scope outdates the older value and everything built from it
([Path scope → At run time](Path-scope#at-run-time)). Each such cascade is **one**
`onValuesOutdated` event — never one per value, and never for a first write into a slot, so
`outdated` is never empty. `ValuesOutdatedEvent` is plain data, without any DTO value (the values
are in `result.record.outdatedValues`):

- the execution's common fields ([below](#every-event)): `executionId`, `parentExecutionId`,
  `rootExecutionId`, `threadId`, `tenantId`, `workflow`;
- `step` — the step that wrote, a `StepRecord`: `component` (`{ name, kind, promptHash,
  schemaHash }`), `nodeId`, `visitNumber`, `copyNumber` (from 1), `itemIndex`, `idempotencyKey`,
  `callId`, `toolLoopIteration`, `validationAttempts`;
- `trigger` — the new value (`valueId`, `slot`, `producer`), the root of the cascade;
- `outdated` — the replaced value first, then what was built from it, each with its `reason`
  (`OutdatedReason.Replaced`, `AboutReplaced`, `BuiltFromReplaced`): the same set as the cascade
  adds to `outdatedValues`, each with `byValueId` = the trigger's `valueId`.

```ts
import { Injectable, OutdatedReason, type OnValuesOutdated, type ValuesOutdatedEvent } from "agboss";

@Injectable()
export class OutdatingAudit implements OnValuesOutdated {
  onValuesOutdated(event: ValuesOutdatedEvent) {
    const answers = event.outdated.filter((value) => value.reason === OutdatedReason.AboutReplaced);
    console.log(
      `${event.step.nodeId} wrote ${event.trigger.valueId}: ${String(answers.length)} answers outdated`,
    );
  }
}
```

The trace gets the same cascade as one "values outdated" entry under the step, with a sentence per
value (`DraftDto#1 outdated: replaced by DraftDto#2 from writer-agent`).

## Parallel launches

A branch of a launch (#273) is named by its copy id in every event and trace: the second copy of
a repeated agent is `critic-agent#2` in `onAgentStart` / `onAgentEnd` (`name`, `step.nodeId`; `step.copyNumber` 2),
in `result.path` and in `executionContext.step.nodeId`; a target listed once keeps its `name`, and
a per-item run its node's `name` with its `step.itemIndex`. Each branch adds one trace entry when it
ends, named `critic-agent#2` or `company-check-agent[3]` (its item's index), with its launch id,
`copyNumber`, `itemIndex` and `status` (`BranchStatus`, and the error's code and message when it
failed, was skipped or cancelled); a model router's launch decision adds a "launch decision" entry
with every route's P(yes).

A per-item launch whose list is longer than its `maxItems` launches the first `maxItems` items and
drops the rest — never an error. It emits **one** `onLaunchItemsTruncated` and a trace entry "launch
items truncated"; `LaunchItemsTruncatedEvent` carries the execution's fields (`executionId`,
`threadId`, `workflow`, …), the launching `step`, the `launch` id
(`${executionId}:${nodeId}:${visitNumber}`, the same as in `result.launches`), how many `items` the
list had and the `maxItems` that were taken. No item values.

```ts
import { Injectable, type LaunchItemsTruncatedEvent, type OnLaunchItemsTruncated } from "agboss";

@Injectable()
export class LaunchAudit implements OnLaunchItemsTruncated {
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent) {
    console.warn(`${event.step.nodeId} found ${String(event.items)}, ran ${String(event.maxItems)}`);
  }
}
```

## Child executions

A child workflow (#263, [Workflow as a step](Workflow-as-a-step#at-run-time)) is an execution of
its own: `onExecutionStart` once when it is first entered (a resume or a recovery that continues it
fires none), `onExecutionEnd` (`finish`, its own `spend`) when it ends at a finish, and
`onExecutionError` when it fails or is cancelled (FailFast: `ExecutionCancelledError`). Its events
and its node events carry its own `executionId`, its `parentExecutionId` and the
`rootExecutionId` of the `app.execute` it belongs to, its parent's `threadId` and `tenantId`, and
its own `workflow`; a pause inside a child is the root's `onExecutionPause`. In traces a child is a
nested run named after its workflow under the parent's step (metadata `executionId`,
`parentExecutionId`, `rootExecutionId`, `itemIndex`).

## Quorums

Under a quorum (#279, [Parallel](Parallel#at-run-time)) each branch's trace entry also carries its
`verdict` (`BranchVerdict.Counted` with `acceptedSequence`, `Rejected` with `rejectedBy` — the
arbiters that rejected it — or `Surplus`; a cancelled branch has none). The join adds a trace entry
"quorum decided" (`launch`, `isReached`, the counted branches in counting order) and emits **one**
`onQuorumDecided`: `QuorumDecidedEvent` is a node event — the common fields and the launching `step` — with the
`launch` id, `isReached`, every branch as `result.launches` shows it (`BranchRecord`: `status`,
`verdict`, `acceptedSequence`, `rejectedBy`) and, for `.joinQuorumGroups(…)`, the winning `group`
(`agents`, `priority`). No answer values. A model arbiter's calls are not agent model calls (no
`onModelStart` / `onModelEnd`); their cost is in `spend` under `arbiter:<name>`.

```ts
import { BranchVerdict, Injectable, type OnQuorumDecided, type QuorumDecidedEvent } from "agboss";

@Injectable()
export class QuorumAudit implements OnQuorumDecided {
  onQuorumDecided(event: QuorumDecidedEvent) {
    const rejected = event.branches.filter((branch) => branch.verdict === BranchVerdict.Rejected);
    console.info(`${event.launch}: reached ${String(event.isReached)}, ${String(rejected.length)} rejected`);
  }
}
```

## Pause answers

Who answered each pause, and how, is not an event of its own — it is in the execution record
(#267 S107): `result.record.pauses` (`{ record: true }` on `execute` / `resume`) lists every
resolved pause of the tree in the order asked — `PauseAnswerRecord` (`pauseId` — none for a
`PauseAnswerer.Channel` pause —, `step`, `role`, `answeredBy`, `responder`, `resolution:
PauseResolution.Decided | Replied | Withdrawn | Cancelled`, `askedAt`, `resolvedAt`, `decision`),
the decision masked like the rest of the record ([Pauses → who answered](Pauses#who-answered-resultrecordpauses)).
`onExecutionResume` still names each decision a pass takes and its `answeredBy`. A reply
interpreter's model call (#267 PR 3) is traced under the pause's execution (its tenant and root
execution in the trace's metadata) and its cost is in `spend` under `reply-interpreter:<name>` —
not an agent model call (no `onModelStart` / `onModelEnd`). It runs in the pause's execution frame
(its tenant for the rate limits) and its model reads through the application's and the workflow's
PII policies. The record's `pauses` come from the execution records
(`ExecutionRecordRepository.findPauseAnswersByTenantIdAndRootExecutionId`): the pause records'
retention never changes them.

## PII in events, logs, traces and the record

Every event an observer gets, every line of the framework's log, every span a trace exports and
`result.record` are masked by the PII policies of the application and of the workflow (#120 AC7) —
always the whole list: an agent's or a router's `excludePiiPolicies` changes only what its own
model reads. The masking uses the formats and a project's own detectors, never a model (nothing
outside a step calls one); a `blockWithRefusal` kind is shown as `<kind>` and fails nothing. An
event keeps its shape — every string masked, a model call's `rawPayload` messages rebuilt with
their content masked, class instances (an `Error`) kept. A trace of the graph's state also hides
the execution's own PII channels: the token map's values (`piiTokens`), the sensitive values
(`piiValues`) and the context fields marked `sensitive`. The tool itself, the scope and the
checkpoint keep the real values ([Guards → PII policies](Guards#pii-policies)).

There is no PII policy hook: `onPiiPolicyStart` / `onPiiPolicyEnd` (the old approval-time masking)
are removed in #120 — an observer that still implements one fails assembly with
`[observer.unknown-hook]`.

## Registering an observer

1. A class decorated with `@Injectable()` (its `deps` injected like any component).
2. It implements the hooks it needs.
3. It is listed in `@Application({ observers })` — the only place; `@Workflow` takes none.

The container creates observers at app start. Assembly rejects an observer with no hook
(`[observer.no-hooks]`) or a misspelled one (`[observer.unknown-hook]`, `did you mean onToolEnd?`).
An observer that throws is a warning in the application's log (`observer.failed`) and never fails
the execution.

## Example: a tracer

<!-- snippet-context
import { Agent, Budget, BudgetPeriod, BudgetScope, WorkflowFinish, WorkflowStart, Workflow, start, type BudgetHandler } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { usd, type Usd } from "agboss/units";
@WorkflowStart({ name: "support-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@Agent({ name: "support-agent", description: "Answers", prompt: "Answer the message.", model: "moonshotai/kimi-k2.6" })
export class SupportAgent {}
@WorkflowFinish({ name: "support-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  flow: [start(ChatWorkflowStart).returns(WorkflowStartTextDto).toAgent(SupportAgent).toFinish(ChatWorkflowFinish)],
})
export class SupportWorkflow {}
@Budget({ name: "support-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class SupportApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}
@Budget({ name: "support-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class SupportTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}
@Budget({ name: "support-execution-budget", scope: BudgetScope.Execution })
export class SupportExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
-->

```ts
import {
  Application,
  EmptyEnvironment,
  Injectable,
  type AgentEndEvent,
  type AgentStartEvent,
  type ExecutionErrorEvent,
  type ModelEndEvent,
  type OnAgentEnd,
  type OnAgentStart,
  type OnExecutionError,
  type OnModelEnd,
} from "agboss";

@Injectable()
export class ConsoleTracer implements OnAgentStart, OnAgentEnd, OnModelEnd, OnExecutionError {
  onAgentStart(event: AgentStartEvent): void {
    console.log(`[trace] ${event.step.nodeId} started in ${event.executionId} (${event.tenantId})`);
  }

  onAgentEnd(event: AgentEndEvent): void {
    console.log(`[trace] ${event.step.nodeId} finished in ${event.executionId}`);
  }

  onModelEnd(event: ModelEndEvent): void {
    console.log(`[trace] ${event.callerName} → ${event.model}: ${String(event.usage.totalTokens)} tokens`);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    console.error(`[trace] ${event.workflow.name} ${event.executionId} failed`, event.error);
  }
}

@Application({
  name: "support-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SupportWorkflow],
  budgets: [SupportApplicationBudget, SupportTenantBudget, SupportExecutionBudget],
  observers: [ConsoleTracer],
})
export class SupportApplication {}
```

## The framework's log

The framework writes its own log through the application's `Logger` (#261) — infrastructure like the
`Clock`: the built-in `ConsoleLogger` writes one line per entry on standard error; your own
`extends Logger` (`write(entry: LogEntry)`, `LogEntry`: `level`, `code`, `message`, `time`,
`executionId?`, `tenantId?`) goes in `@Application({ providers })`. It replaces the process warnings
of earlier versions. A logger that throws is ignored.

**At start, once**, only what the decorators say — no project code is called (no `maxSpend()`, so
no budget amount), nothing per tenant — two kinds of lines, then the startup warnings:

```text
15:02:11 INFO  Started job-scout-application 1.0.0 — environment prod, host scout-7f3a, process 41237
15:02:11 INFO  Worst case of one chat-workflow-start call: 1 workflow execution, 1 at the same time, 12 agent and router steps
15:02:11 WARN  [application.in-memory-pauses] in-memory pauses: another application instance cannot resume them and they are lost on restart [app.warning]
```

More at start is the project's own: a component with `OnStart` logs what it wants (a budget is a
component and can be injected).

**While it runs**, only problems of the system: `LogLevel.Warn` at risk (`execution.recovered`,
`recovery.incompatible`, `observer.failed`) and `LogLevel.Error` broken (`recovery.failed`,
`app.close-failed`), each with its `executionId` / `tenantId` for search. One execution's details
are its trace; a tenant's spend is the cost ledger; a rejected execution is `onExecutionRejected`.

**Assembly warnings** (in `app.warnings` and the start log; errors under `agboss check --strict`;
silent in tests — `testWith` logs no start and no warning, and an unlisted `Logger` is silent
there):

| Code                                 | When                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `application.in-memory-cost-ledger`  | tenant or application budgets on the built-in in-memory ledger: each instance counts on its own, the counters reset on restart |
| `application.in-memory-pauses`       | a workflow can pause (a tool with a channel) on the built-in in-memory paused executions or checkpoints |
