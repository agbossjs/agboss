# Observability

Observers see an application's executions: their start, pause, resume, end and failure, the
requests refused before an execution, and the node events — agent, router, tool, model, knowledge
base, guardrail, action, channel and judge start / end, outdated values, truncated
launches. They are registered, not discovered: only `@Observer` classes listed in
`@Application({ observers: [...] })` are called (#261, #1343) — the one place, never in `@Workflow`;
one instance each, for every execution of the application, child executions included. Tracing is vendor-neutral OpenTelemetry
(`createApp({ tracerProvider })`, [Tracing](Tracing)); observers are for everything else (metrics, your own tracer, audit). What the
framework itself writes is its [log](#the-frameworks-log).

## Every event

One event object per hook, plain data — never the framework's internal state (the full record of
an execution is `result.record`). Every execution event extends `ExecutionEvent`:

| Field               | What                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `executionId`       | unique per execution, the same after a resume (`result.executionId`)          |
| `parentExecutionId` | the execution that launched this child (#263); `undefined` at the root        |
| `rootExecutionId`   | the root's id; the execution's own at the root                                |
| `threadId`          | the conversation                                                              |
| `tenantId`          | the tenant it works for (`"default"` when it names none)                      |
| `workflow`          | a `WorkflowRecord` `{ name, version, startedVersion, configHash }` — no class |

A node event (`NodeEvent`) adds `step`, a `StepRecord` — the serialized `executionContext.step`:
`component` (a `ComponentRecord`, no class), `nodeId` (`critic-agent#2` for a copy), `visitNumber`,
`copyNumber`, `itemIndex`, `idempotencyKey`, `callId` (during a tool call), `toolLoopIteration`,
`validationAttempts` ([Join keys](#join-keys) below). An observer interested
in one workflow or agent says so in the decorator — `@Observer({ workflows: [SupportWorkflow], agents:
[CriticAgent] })` — and its hooks receive only those events; otherwise it filters by name, taken
with `nameOf(C)` (any AGBoss-decorated class; an undecorated one throws `ConfigError.Component`):
`event.step.component.name === nameOf(CriticAgent)` — never by parsing `nodeId`.

### Join keys

Every event, record and trace joins the declarative snapshot of [`agboss describe
--json`](CLI#the-declarative-snapshot-268) without generating code back into TypeScript (#268 S92 /
S93) — for analytics over Langfuse and `ExecutionRecordRepository`, OpenAPI generators, or checking
a checkpoint against a release:

| Key                                      | Where                                                         | What                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `configHash`                             | `event.workflow`, `executionContext.workflow`, records        | the one key of the workflow: the fingerprint of its config, flow and every text its models read                                           |
| `component.kind`                         | `event.step.component`, `finish`, errors, handled errors      | `ComponentKind`: `WorkflowStart`, `Agent`, `Router`, `Action`, `WorkflowFinish`, `Workflow`, `Budget`, …                                  |
| `component.promptHash`                   | the same                                                      | the hash of what its model is told (an agent's instructions, a model router's prompt and routes); `undefined` without a model             |
| `component.schemaHash`                   | the same                                                      | the hash of what it reads and writes (`input` fields, `output`), each DTO by its JSON Schema's hash; `undefined` when it declares neither |
| `step.toolLoopIteration`                 | `event.step`, `executionContext.step`, `record.pauses[].step` | an agent's model call in the visit, from 1 — during the call and the tool calls its move asks for; `undefined` elsewhere                  |
| `step.validationAttempts`                | the same                                                      | the step's answers and tool arguments that failed validation so far, each sent back to the model                                          |
| `visitNumber`, `copyNumber`, `itemIndex` | `event.step`                                                  | the visit, the copy and the item of a launch (#273)                                                                                       |

A branch's outcome — `BranchStatus` and, under a quorum, `BranchVerdict` — is in `result.launches`
and `onQuorumDecided`, joined by `nodeId`, `copyNumber` and `itemIndex`. `toolLoopIteration` is not
part of `idempotencyKey` (#335): the key's format is unchanged.

```ts
import { Observer, type ModelEndEvent } from "@agboss/core";

@Observer()
export class JoinKeyLog {
  onModelEnd(event: ModelEndEvent): void {
    const { configHash } = event.workflow; // describe --json: workflows[].configHash
    const { name, promptHash, schemaHash } = event.step.component; // workflows[].nodes[]
    const iteration = event.step.toolLoopIteration; // 1, 2, … within the agent's visit
    console.info(configHash, name, promptHash, schemaHash, iteration, event.costUsd);
  }
}
```

## The hooks

An observer is a class with `@Observer({ name?, description?, workflows?, agents?, deps? })` and a
method per hook it wants; every parameter is typed by its event, no `implements` is needed
(`ExecutionObserver` is the type of all the hooks, each optional). Listed in `@Application({ observers })`, it is checked at assembly: a
misspelled `on…` method is `[observer.unknown-hook]` with the hook it meant, a class without
`@Observer` is `[observer.not-an-observer]`, and two with one name are `[observer.duplicate-name]`
(the name is the class name in kebab-case unless given). `workflows` / `agents` pass only the events
of those workflows / agents; app-level events (no workflow or agent) go to an observer without that
filter, and a standalone `@Tool` call through an `@McpEndpoint` has no `agent`.

| Hook                                                  | Payload                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onExecutionStart`                                    | `ExecutionStartEvent` (the common fields)                                                                                                                       |
| `onExecutionEnd`                                      | `ExecutionEndEvent` (`finish`: a `ComponentRecord`, `output`, `spend`)                                                                                          |
| `onExecutionPause` / `onExecutionResume`              | `ExecutionPauseEvent` (`pending`) / `ExecutionResumeEvent` (`reason`, `decision`, `actor`)                                                                      |
| `onExecutionError`                                    | `ExecutionErrorEvent` (`error`)                                                                                                                                 |
| `onExecutionRejected`                                 | `ExecutionRejectedEvent` (`operation`, `threadId?`, `tenantId`, `code`, `message`)                                                                              |
| `onAgentStart` / `onAgentEnd`                         | `AgentStartEvent` / `AgentEndEvent` (`output`)                                                                                                                  |
| `onAgentRetry`                                        | `AgentRetryEvent` (`agent`, `reason`: `InvalidAnswer`, `InvalidToolInput`, `JudgeRejected`; `attempt`, `maxAttempts`, `feedback`)                               |
| `onRouterStart` / `onRouterEnd`                       | `RouterStartEvent` / `RouterEndEvent`                                                                                                                           |
| `onToolStart` / `onToolEnd`                           | `ToolStartEvent` (`tool`, `agent?`, `input`) / `ToolEndEvent` (`tool`, `agent?`, `output`, `isResultTruncated` — #336)                                          |
| `onModelStart` / `onModelEnd`                         | `ModelStartEvent` / `ModelEndEvent` (`model`, `caller`; the end: `usage` (`TokenUsage`), `costUsd`)                                                             |
| `onCircuitStateChange`                                | `CircuitStateChangeEvent` (`provider`, `from`, `to`: `closed`, `open`, `half-open`; `at`) — the application's, no `workflows` / `agents` filter lets it through |
| `onArbiterStart / onArbiterEnd`                       | `ArbiterStartEvent` / `ArbiterEndEvent` (`arbiter`, `target`, `isCode`; the end: `outcome`, `costUsd`)                                                          |
| `onRerankStart / onRerankEnd`                         | `RerankStartEvent` / `RerankEndEvent` (`rag`, `reranker`, `candidates`, `topK`; the end: `outcome`, `results`, `costUsd`)                                       |
| `onModelFallback`                                     | `ModelFallbackEvent` (the providers and models, `reason`, `error` as class and code, `caller`), once per hop, in the step that made the call                    |
| `onChannelInterpreterStart / onChannelInterpreterEnd` | `ChannelInterpreterStartEvent` / `ChannelInterpreterEndEvent` (`interpreter`, `channel`, `isCode`; the end: `outcome`, `costUsd`)                               |
| `onTtlSweep`                                          | `TtlSweepEvent` (`at`, `durationMs`, `categories`) — the application's, no `workflows` / `agents` filter lets it through                                        |
| `onPauseTimeoutChanged / onPauseReassigned`           | `PauseTimeoutChangedEvent` / `PauseReassignedEvent` (where the pause waits and its deadlines; never its id or the assignee)                                     |
| `onRagStart` / `onRagEnd`                             | `RagStartEvent` / `RagEndEvent`                                                                                                                                 |
| `onActionStart` / `onActionEnd`                       | `ActionStartEvent` / `ActionEndEvent`                                                                                                                           |
| `onGuardrailStart` / `onGuardrailEnd`                 | `GuardrailStartEvent` (`input`: `side`, `component` (a `ComponentRecord`), the masked `text`) / `GuardrailEndEvent` (`output`: `isBlocked`, `probability`)      |
| `onChannelStart` / `onChannelEnd`                     | `ChannelStartEvent` / `ChannelEndEvent`                                                                                                                         |
| `onJudgeStart` / `onJudgeEnd`                         | `JudgeStartEvent` / `JudgeEndEvent` (`judge`, `agent`, `output`)                                                                                                |
| `onValuesOutdated`                                    | `ValuesOutdatedEvent` (step, trigger, outdated — [below](#outdated-values))                                                                                     |
| `onLaunchItemsTruncated`                              | `LaunchItemsTruncatedEvent` (step, launch, items, takeFirst — [below](#parallel-launches))                                                                      |
| `onQuorumDecided`                                     | `QuorumDecidedEvent` (step, launch, isReached, branches, group — [below](#quorums))                                                                             |
| `onCompensationStart` / `onCompensationEnd`           | `CompensationStartEvent` (step, compensated, reason) / `CompensationEndEvent` (+ status, error — [below](#automatic-undo))                                      |
| `onExecutionLeaseTakeover`                            | `ExecutionLeaseTakeoverEvent` (tenant, root, lease execution, scope key, token, holders, reason — [below](#lease-takeovers-501))                                |
| `onStepHandedOver`                                    | `StepHandedOverEvent` (step, reason, site, scope key, holder, token, observedToken — [below](#hand-overs-501))                                                  |
| `onIdempotencyRun`                                    | `IdempotencyRunEvent` (step, name, scope key, token, outcome, writtenToken, observedToken — [below](#idempotent-writes-501))                                    |

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

| Refusal                                                              | Operation                     | `code`                   |
| -------------------------------------------------------------------- | ----------------------------- | ------------------------ |
| a thread of another owner (`ExecutionError.ThreadOwnerMismatch`)                       | `Execute`, `Resume`, `Cancel` | `execution.thread-owner-mismatch`       |
| nothing paused on the thread (`NotPausedError`)                      | `Resume`                      | `run.not-paused`         |
| an unknown thread of the tenant (`ExecutionError.UnknownThread`)               | `Execute`, `Cancel`           | `execution.unknown-thread`     |
| a class that is not a start of the workflow                          | `Execute`                     | `config.not-a-workflow-start`   |
| invalid start input or context values (`ValidationError.DtoInvalid`) | `Execute`                     | `validation.dto-invalid` |
| an exhausted budget before the first step                            | `Execute`                     | `limit.budget`           |
| the app is stopping (`ApplicationStoppingError`)                     | `Execute`, `Resume`           | `app.stopping`           |

For invalid input the message names the DTO and its fields (`invalid Voucher at code`), never
their values; the thrown error keeps the full message. A resume refused after a deploy
(`ExecutionError.IncompatibleResume`) is not a refused request: the paused execution is known, so it is an
`onExecutionError` with its `executionId` and thread, and it stays paused — resumable by an app
whose `onIncompatibleResume` policy accepts it.

```ts
import {
  ExecutionOperation,
  Observer,
  type ExecutionRejectedEvent,
} from "@agboss/core";

@Observer()
export class Audit {
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
  (`OutdatedReason.Replaced`, `BuiltFromReplaced`): the same set as the cascade
  adds to `outdatedValues`, each with `byValueId` = the trigger's `valueId`.

```ts
import { Observer, OutdatedReason, type ValuesOutdatedEvent } from "@agboss/core";

@Observer()
export class OutdatingAudit {
  onValuesOutdated(event: ValuesOutdatedEvent) {
    const answers = event.outdated.filter((value) => value.reason === OutdatedReason.BuiltFromReplaced);
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

A per-item launch whose list is longer than its `takeFirst` launches the first `takeFirst` items and
drops the rest — never an error. It emits **one** `onLaunchItemsTruncated` and a trace entry "launch
items truncated"; `LaunchItemsTruncatedEvent` carries the execution's fields (`executionId`,
`threadId`, `workflow`, …), the launching `step`, the `launch` id
(`${executionId}:${nodeId}:${visitNumber}`, the same as in `result.launches`), how many `items` the
list had and the `takeFirst` that were taken. No item values.

```ts
import { Observer, type LaunchItemsTruncatedEvent } from "@agboss/core";

@Observer()
export class LaunchAudit {
  onLaunchItemsTruncated(event: LaunchItemsTruncatedEvent) {
    console.warn(`${event.step.nodeId} found ${String(event.items)}, ran ${String(event.takeFirst)}`);
  }
}
```

## Child executions

A child workflow (#263, [Workflow as a step](Workflow-as-a-step#at-run-time)) is an execution of
its own: `onExecutionStart` once when it is first entered (a resume or a recovery that continues it
fires none), `onExecutionEnd` (`finish`, its own `spend`) when it ends at a finish, and
`onExecutionError` when it fails or is cancelled (a sibling branch's failure: `ExecutionCancelledError`) — each at
most once, by the pass that ended it (#562): an `AnyWorker` child's finish on the instance whose
worker completed its queue row, a child on its parent's instance by the parent's pass that ran it,
a remote child's failure by the parent's pass that saw it; a parent that re-enters its step after a
takeover only reads the end and announces nothing
([Guarantees across processes](Guarantees-across-processes#what-a-reader-of-the-records-should-know)). Its events
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
import { BranchVerdict, Observer, type QuorumDecidedEvent } from "@agboss/core";

@Observer()
export class QuorumAudit {
  onQuorumDecided(event: QuorumDecidedEvent) {
    const rejected = event.branches.filter((branch) => branch.verdict === BranchVerdict.Rejected);
    console.info(`${event.launch}: reached ${String(event.isReached)}, ${String(rejected.length)} rejected`);
  }
}
```

## Automatic undo

Each undo action the framework runs by itself (#340: a failed join's finished branches,
[Rollback](Rollback#a-failed-join-undoes-its-finished-branches); an execution that ends without a
finish, [Rollback](Rollback#an-execution-that-ends-without-a-finish)) is reported by
`onCompensationStart` and `onCompensationEnd`, around the undo action's own `onActionStart` /
`onActionEnd`: `step` is the undo action's step (its key `<undone step's key>:compensation`,
`step.compensates` the step it undoes), `compensated` the step it undoes, `reason` a
`CompensationReason` (`JoinFailed`, `ExecutionFailed`, `ExecutionCancelled`); the end adds `status` (`CompensationStatus.Compensated` /
`Failed`) and, when it failed, `error`. An undo on a side path is an ordinary action step: its
`onActionStart` / `onActionEnd` only. Both kinds are in `result.compensations`.

An execution that fails (`onExecutionError`) carries them too: `ExecutionErrorEvent.compensations`
— the `CompensationRecord`s of the undo actions that ran for it, its side paths' first, then the
automatic undo of its end in the order they ran (`[]` when none ran); a failed undo is there with
`status: CompensationStatus.Failed`, and the event's `error` is then `ExecutionError.CompensationFailed`. A
child's event lists its own; a root's its own and those its end undid for a paused child.

```ts
import { CompensationStatus, Observer, type CompensationEndEvent } from "@agboss/core";

@Observer()
export class CompensationAudit {
  onCompensationEnd(event: CompensationEndEvent) {
    if (event.status === CompensationStatus.Failed)
      console.warn(`${event.compensated.component.name} not undone: ${event.error?.message ?? ""}`);
  }
}
```

## Lease takeovers (#501)

`onExecutionLeaseTakeover` tells that an instance took a tree's lease over. Like a refused request
it names no workflow and no thread — a lease belongs to a tree: `ExecutionLeaseTakeoverEvent` has
`tenantId`, `rootExecutionId`, `leaseExecutionId` (the root, or a `ChildPlacement.AnyWorker`
child's own lease), `scopeKey` and `token` (the new holder's `executionContext.fence`),
`holderInstanceId`, `previousHolderInstanceId` / `previousToken` when the lease store names the
holder whose lease expired (`ExecutionLease.takenOverFrom`), `checkpointId` (the tree's head
checkpoint, where the take reads it) and `reason`, a `LeaseTakeoverReason`: `Recovered`, `Resumed`,
`Cancelled`, `Unwinding`, `RemoteChild` or `Reclaimed`. A take is a takeover when the store names
an expired holder, and at every take of the recovery sweep, an undo's takeover, a remote child's
reclaim and a reclaim after a yield; a lease released and taken again is none, and so is a take
of work already over — a finished child, a root whose record no longer runs
([#520](Several-instances#finished-work-is-never-taken-over-520)). The same facts
are a row of the audit log, written first ([Several instances → The audit log](Several-instances#the-audit-log-501));
an observer that throws is a warning (`observer.failed`) and never reaches the takeover.

```ts
import {
  Observer,
  LeaseTakeoverReason,
  type ExecutionLeaseTakeoverEvent,
} from "@agboss/core";

@Observer()
export class TakeoverAlert {
  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent) {
    if (event.reason === LeaseTakeoverReason.Recovered && event.previousHolderInstanceId !== undefined)
      console.warn(`${event.previousHolderInstanceId} lost ${event.scopeKey}; token ${event.token}`);
  }
}
```

## Hand-overs (#501)

A step that stops without failing — its lease was lost (`ExecutionLeaseLostError`), an external
system refused one of its writes (`ExecutionError.Fenced`) or the instance stopped past its shutdown
timeout (`ApplicationStoppingError`) — reaches no `.onError`, no undo and no `onExecutionError`
([Several instances](Several-instances#fencing-external-writes-471)), but `onStepHandedOver` tells
it: `StepHandedOverEvent` is a node event — the common fields and the `step` that stopped (its
`nodeId`, `visitNumber`, `idempotencyKey`, a tool call's `callId`) — with `reason`
(`HandOverReason.LeaseLost`, `Fenced`, `ApplicationStopping`), `site` (`HandOverSite.Step`, `Tool`,
`ToolInterceptor`, `Compensation`, `Branch`, `Child`: the innermost part of the step that found
it), `scopeKey` and `token` (a refused write's own), `observedToken` (the token the external system
saw, when it said) and `holderInstanceId`. One event per error and lease scope: a fenced tool call
rethrown through the agent's loop and its step is one `Tool` event. Its row of the audit log is
written first, and the lease is released — the moving call rejects — only after it.

```ts
import {
  HandOverReason,
  Observer,
  type StepHandedOverEvent,
} from "@agboss/core";

@Observer()
export class ZombieWriteAlert {
  onStepHandedOver(event: StepHandedOverEvent) {
    if (event.reason === HandOverReason.Fenced)
      console.warn(`${event.step.idempotencyKey}: token ${event.token} refused, ${String(event.observedToken)} seen`);
  }
}
```

## Idempotent writes (#501)

Each call of a step's `Idempotency.runOnce` (#500 —
[Several instances](Several-instances#the-fenced-effect-500)) is told by `onIdempotencyRun`:
`IdempotencyRunEvent` is a node event — the step that called it — with the effect's `name`, the
call's `scopeKey` and `token`, `outcome` (`IdempotencyRunEventOutcome.Ran`, `Replayed` — the stored
result came back, nothing written again —, `Joined`, `Refused` — the lease or the scope's mark
refused it), `writtenToken` (the token the result was first written under) and `observedToken`
(the newer token behind a refusal), and `holderInstanceId`. Never the result. A write that fails
for itself (a result too large, a business error) is no outcome. Its row of the audit log comes
first, in the lease's order: a refused call before the hand-over it causes.

## Outbound calls (#505)

Each move of a step's call that leaves the system (`Idempotency.sendOnce` —
[Several instances](Several-instances#calls-that-leave-the-system-505)) is told by `onOutboundCall`:
`OutboundCallEvent` is a node event — the step that made the call — with the call's `name`,
`target` and `operation`, the intent's `status` (`OutboundCallStatus`) and `attempt` after the
move, `outcome` (`OutboundCallEventOutcome.Recorded` — the intent written, nothing sent yet —,
`Sent`, `Replayed`, `Reconciled`, `NotSent` — the recovery found it never arrived (`Reconciliation.notExecuted()`), it goes out again
—, `Unknown` — the step fails with `OutboundCallError.Unreconciled` (also a resend refused past
the recovery's window, #658) —, `Failed` — a definite failure (`isDefiniteFailure`, #657) —,
`Ambiguous` — `send` threw an error of unknown outcome: the intent stays pending, the next call
recovers it (#657) —, `Joined` — the same
call of this instance was made meanwhile, its outcome shared), the lease's
`scopeKey` and `token`, and `holderInstanceId`. Never the request or the result. Its
`OutboundCall` row of the audit log is written first; an observer that throws is a warning.

<!-- snippet-context
import {
  Observer,
  OutboundCallEventOutcome,
  type OutboundCallEvent,
} from "@agboss/core";
-->

```ts
@Observer()
export class UnreconciledCallAlert {
  onOutboundCall(event: OutboundCallEvent) {
    if (event.outcome === OutboundCallEventOutcome.Unknown)
      console.warn(`${event.target} ${event.operation}: left pending at attempt ${event.attempt}`);
  }
}
```

## Pause answers

Who answered each pause, and how, is not an event of its own — it is in the execution record
(#267 S107): `result.record.pauses` (`{ includeRecord: true }` on `execute` / `resume`) lists every
resolved pause of the tree in the order asked — `PauseAnswerRecord` (`pauseId` — none for a
`PauseRespondent.Delegate` pause —, `step`, `role`, `answerer`, `actor` (the person), `resolution:
PauseResolution`, `askedAt`, `resolvedAt`, `decision`),
the decision masked like the rest of the record ([Pauses → who answered](Pauses#who-answered-resultrecordpauses)).
`onExecutionResume` still names each decision a pass takes and its `actor`. A reply
interpreter's model call (#267 PR 3) is traced under the pause's execution (its tenant and root
execution in the trace's metadata) and its cost is in `spend` under `reply-interpreter:<name>` —
not an agent model call (no `onModelStart` / `onModelEnd`). It runs in the pause's execution frame
(its tenant for the rate limits) and its model reads through the application's and the workflow's
PII policies. The record's `pauses` come from the execution records
(`ExecutionRecordRepository.findPauseAnswersByTenantIdAndRootExecutionId`): the pause records'
retention never changes them.

## Tool calls and steps

What an execution did step by step is in its result and record too (#395), not only in the events:

- `result.toolCalls` — every tool call of the root execution's agents, in call order, real values
  (like `output`); each child's own in `result.children[i].toolCalls`. One `ToolCallRecord` per
  call: `step` (its `component` is the tool with its join keys — `promptHash` of its description,
  `schemaHash` of its input and output, as `describe --json` gives them —; `nodeId` / `visitNumber`
  the agent's visit; `callId`, `toolLoopIteration`, `validationAttempts`), `input`, `output`,
  `status: ToolCallStatus` (`Succeeded`, `Failed`, `InvalidArguments`, `Declined`, `TimedOut`, and
  for a tool interceptor's decision, #384: `Replied` — `output` is its message — and `Blocked`),
  `error?`, `isResultTruncated`, `startedAt`, `endedAt`. A call to a tool the agent does not have is
  `UnknownTool` (#395 S6): nothing ran, `step.component` names what the model called, `error` what
  it read.
- `result.record.toolCalls` (`{ includeRecord: true }`) — the same, masked like the rest of the record.
- `result.record.steps` — one `ExecutionStepRecord` per visit of a node, in the order the visits
  ended: `step`, `inputHash` (a stable hash of the values it read — the same input, the same hash on
  every machine and run; a start's is its input's), `decision?` (#401: what it decided — `route:<node>`
  for a router, `launch:<node>,…` for the routes it launched, `variant:<class>` for a `oneOf` answer,
  else `answer:<hash>` of its value — never the value itself, so it holds no PII; none when it gave
  nothing — what the [Mesh Hub](Mesh-Hub)'s radar counts), `judgeVerdicts` (`JudgeVerdictRecord`: `judge`,
  `attempt`, `passed`, `reason?`, `metrics?`), `guardrailDecisions` (`GuardrailDecisionRecord`:
  `guardrail`, `side`, `isBlocked`, `probability`), `spend`, `startedAt`, `endedAt` and `error?` —
  the failure a side path took. Each child's own are in `result.children[i].steps` (#395 S6).
- **A failed visit keeps its records** (#395 S6): an agent whose step fails — a
  `StepError.QualityGate`, a call a tool interceptor blocked, a guardrail's block, a limit, any error —
  keeps the tool calls it made, its judges' verdicts and its guardrails' decisions (the blocking one
  last). A side path that takes the failure records them in `toolCalls` and in the visit's `steps`
  entry (with its `error`); a failed parallel branch does the same; a failure no side path takes
  ends a child with them in its `ChildExecutionRecord` (`toolCalls`, `steps`). A root execution that
  fails returns no result.
- A model call whose tool-call arguments are no JSON (truncated; the provider's
  `invalid_tool_calls`) is an `InvalidArguments` call, counted in `validationAttempts` — the model
  reads why and tries again; a truncated answer is an invalid answer.

## PII in events, logs, traces and the record

Every event an observer gets, every line of the framework's log, every span a trace exports and
`result.record` are masked by the PII policies of the application and of the workflow (#120 AC7) —
always the whole list: an agent's or a router's `excludePiiPolicies` changes only what its own
model reads. It is the workflow **of that run** (#1130): a run of a workflow that lists a policy is
masked by it whatever the application's other workflows list; a run is never masked by another
workflow's list. A child's run is masked by its **chain** (#1150): the application's, the root's,
every ancestor's and its own lists — its spans (each step's `workflowChain` metadata names the
chain; a chain naming a workflow the application does not trace, or one that is unreadable, is
masked by every workflow's mask), its log, every event of it (its own start, end and error
included), its record in the root's `result.record.children` and kept history, its pause answers
in the root's `record.pauses`, its pending pauses in the root's `onExecutionPause`, its outbound
calls and its pause notices — on its parent's instance or any other. The root's own fields are
masked by the root's chain only: a policy only a child lists masks the child's part, never the
root's ([Guards → Levels](Guards#levels)). What belongs to no one run — the
application's own log (an observer's failure, a startup line) and its audit log — is masked by the
union of the application's and every workflow's policies, as is a span that names none of its
application's workflows: fail closed, never weaker than any run's own mask
([Tracing → Off by default](Tracing#off-by-default)). The masking uses the formats and a project's own detectors, never a model (nothing
outside a step calls one); a `block` kind is shown as `<kind>` and fails nothing. An
event keeps its shape — every string masked, a model call's `messages` (plain `ShownModelMessage`s, #1313f) with
their content masked, class instances (an `Error`) kept. A trace of the graph's state also hides
the execution's own PII channels: the token map's values (`piiTokens`), the sensitive values
(`piiValues`) and the context fields marked `sensitive`. The tool itself, the scope and the
checkpoint keep the real values ([Guards → PII policies](Guards#pii-policies)).

There is no PII policy hook: `onPiiPolicyStart` / `onPiiPolicyEnd` (the old approval-time masking)
are removed in #120 — an observer that still implements one fails assembly with
`[observer.unknown-hook]`.

## Metrics

The numbers behind autoscaling — queued children, step slots, held leases, and counters of
takeovers, hand-overs, ended executions and undo actions — are published through an OpenTelemetry
meter the app is given, by a built-in observer called before yours: [Metrics](Metrics) (#485).

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
import { inline, Agent, Budget, BudgetPeriod, BudgetScope, WorkflowFinish, WorkflowStart, Workflow, onStart, type BudgetHandler, Ttl } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
@WorkflowStart({ name: "support-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@Agent({ name: "support-agent", description: "Answers", prompt: inline("Answer the message."), model: "moonshotai/kimi-k2.6" })
export class SupportAgent {}
@WorkflowFinish({ name: "support-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatWorkflowStart).toAgent(SupportAgent).toFinish(ChatWorkflowFinish)],
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
  Observer,
  type AgentEndEvent,
  type AgentStartEvent,
  type ExecutionErrorEvent,
  type ModelEndEvent,
} from "@agboss/core";

@Observer()
export class ConsoleTracer {
  onAgentStart(event: AgentStartEvent): void {
    console.log(`[trace] ${event.step.nodeId} started in ${event.executionId} (${event.tenantId})`);
  }

  onAgentEnd(event: AgentEndEvent): void {
    console.log(`[trace] ${event.step.nodeId} finished in ${event.executionId}`);
  }

  onModelEnd(event: ModelEndEvent): void {
    console.log(`[trace] ${event.caller} → ${event.model}: ${String(event.usage.inputTokens + event.usage.outputTokens)} tokens`);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    console.error(`[trace] ${event.workflow.name} ${event.executionId} failed`, event.error);
  }
}

@Application({
  name: "support-application",
  version: "1.0.0",
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
15:02:11 INFO  Started job-scout-application 1.0.0 — profiles base+prod, host scout-7f3a, process 41237
15:02:11 INFO  Worst case of one chat-workflow-start call: 1 workflow execution, 1 at the same time, 12 steps
15:02:11 WARN  [application.in-memory-pauses] in-memory pauses: the pause records (PausedExecutionRepository) and the checkpoints (BaseCheckpointSaver) are kept in memory — another application instance cannot resume a pause and it is lost on restart — name a durable @DatabaseStorage in @Application({ storage }) [app.warning]
```

More at start is the project's own: a component with `OnStart` logs what it wants (a budget is a
component and can be injected).

`LogLevel.Debug` is the fourth level, for a developer's own sink: the framework itself writes none.

**While it runs**, only problems of the system: `LogLevel.Warn` at risk (`execution.recovered`,
`recovery.incompatible`, `observer.failed`, `pause.notice-failed`, `pause.notice-recipient-unknown`,
`pause.expiry-handler-failed`, `pause.expiry-failed`, `pause.reminder-failed`, `pause.reassign-send-failed`,
`pause.resend-failed`) and
`LogLevel.Error` broken (`recovery.failed`, `app.close-failed`, `pause.notice-dead`,
`pause-timers.failed`), each with its `executionId` / `tenantId` for search. The pause notices
(#940, [Pauses → Telling the channel and the listeners](Pauses#telling-the-channel-and-the-listeners-940))
log a failed attempt (`pause.notice-failed`: the receiver, the pause's `pauseKey`, a fixed problem
code), a mailbox set aside after `retention.pauseRecords` (`pause.notice-dead`) and a receiver no
instance knows (`pause.notice-recipient-unknown`); a look of the pause timers that failed is
`pause-timers.failed` (the other looks and the next tick go on). A pause's deadline (#941, #942) adds three
warnings, each with the tenant and the root execution and never an error's message: an expiry handler that
threw, timed out or answered wrongly (`pause.expiry-handler-failed`, the expiry then fails the step), the
expiry machinery itself failing for a pause (`pause.expiry-failed`) and a reminder that failed
(`pause.reminder-failed`) — the look goes on with the other pauses. A reassignment (#946) adds two more, each with the
tenant and the root execution and never the new pause's id: the new send that failed right after the write
(`pause.reassign-send-failed`) and the re-send look's failed attempt (`pause.resend-failed`); the look asks again. One execution's details
are its trace; a tenant's spend is the cost ledger; a rejected execution is `onExecutionRejected`.

**Assembly warnings** (in `app.warnings` and the start log; errors under `agboss check --strict`;
silent in tests — `testWith` logs no start and no warning, and an unlisted `Logger` is silent
there):

| Code                                | When                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application.in-memory-cost-ledger` | tenant or application budgets on the built-in in-memory ledger: each instance counts on its own, the counters reset on restart                                                  |
| `application.in-memory-pauses`      | a workflow can pause (a tool with a channel) on the built-in in-memory paused executions or checkpoints — the message names the one left in memory (#644)                       |
| `application.in-memory-child-queue` | a child is launched with `placement: ChildPlacement.AnyWorker` on the built-in in-memory child queue: it runs only on the instances of the process that launched it (#333 PR 2) |

## Files in events, traces and records (#899)

A file in a model request, an event, a trace, the record or a cassette is shown as `{ kind, mediaType,
filename?, sizeBytes, sha256 }` — a content part's bytes and an `FileDto`'s `inline` never leave as text.
An input guardrail's event lists the files it checked the same way (`FileSummary`). See [Files for
models](Files-for-models).
