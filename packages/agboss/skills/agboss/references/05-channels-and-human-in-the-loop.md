# 05 — Channels and human in the loop

Read this when a tool call must be approved by a person or a system before it runs, when a
workflow asks a person a typed question and goes on with the answer (a question role, #659), when an
execution pauses and is answered later (`app.resume`), or when a reply arrives as free text.
Tools themselves: `03-components-di-and-lifecycle.md`; durable stores: `09-persistence-k8s-and-deploy.md`.

## How a pause works

1. A `@Tool({ channel })` (or `@McpTool`) names a **channel role** — a project's abstract class
   `@ChannelRole({ approves: ToolInputDto, answerer })` that `extends ChannelOf<Self>`.
2. Before every call of that tool the framework creates a pause record (`PausedExecutionRepository`,
   keyed by the step's idempotency key) and calls the role's one implementation —
   `send(ask: ChannelAsk<Role>)`, `ask = { pauseId, value }` (`value.arguments` typed by the tool's input).
3. `send` returns `ChannelOutcome.decided(decision)` (go on at once — a rule decided) or
   `ChannelOutcome.awaitReply()` (the execution rests, `result.status === ExecutionStatus.Paused`,
   `result.pending: PendingPause[]`).
4. Later, a webhook, a CLI or a scheduler answers by the pause's id: `app.resume({ pauseId,
decision }, { tenantId, answeredBy | ownerId })` — or with free text, `{ pauseId, reply }`, read
   by the role's `@ReplyInterpreter`. Approved → the tool runs once (with `overrideArguments` if
   given); rejected → the model reads `Tool error: the call was rejected …` and goes on.

A pause is a tool call through a channel — or a **question step** of the flow,
`.toQuestion(QuestionRole)` (below: Questions). Nothing waits in memory — a pause survives a
restart when the pause store and the checkpointer are durable.

## A worked example: refunds approved in Slack

```ts file=src/refunds/dto/refund-request.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class RefundRequestDto {
  @Text({ prompt: "the order to refund" })
  orderId!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}
```

```ts file=src/refunds/dto/refund-done.dto.ts
import { Text } from "@agboss/core/dto";

export class RefundDoneDto {
  @Text({ prompt: "the refund's id" })
  refundId!: string;
}
```

```ts file=src/refunds/services/slack-client.service.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class SlackClientService {
  postApproval(_replyKey: string, _text: string): Promise<void> {
    return Promise.resolve(); // posts the message with buttons keyed by the reply key
  }

  closeApproval(_replyKey: string, _text: string): Promise<void> {
    return Promise.resolve(); // replaces the buttons with a note
  }
}
```

```ts file=src/refunds/reply-interpreters/refund/refund.reply-interpreter.ts
// free text → a decision, by code (DecidedBy.Model: a chat model, or a decision model for yes / no)
import { DecidedBy, ReplyInterpretation, ReplyInterpreter } from "@agboss/core";
import type { InputOf, OutputOf, ReplyInterpreterHandler } from "@agboss/core";

@ReplyInterpreter({
  name: "refund-reply-interpreter",
  description: "Reads a manager's Slack reply to a refund",
  decidedBy: DecidedBy.Code,
})
export class RefundReplyInterpreter implements ReplyInterpreterHandler<RefundReplyInterpreter> {
  interpret(input: InputOf<RefundReplyInterpreter>): ReplyInterpretation<OutputOf<RefundReplyInterpreter>> {
    const reply: string = input.reply.trim().toLowerCase(); // input.ask is the original question
    if (reply === "approve") return ReplyInterpretation.understood({ approved: true });
    if (reply.startsWith("reject")) return ReplyInterpretation.understood({ approved: false, reason: reply });
    return ReplyInterpretation.notUnderstood({ reason: `not "approve" or "reject …": ${input.reply}` });
  }
}
```

```ts file=src/refunds/channels/refund-approval.channel-role.ts
// channels/refund-approval.channel-role.ts — the role: what it approves and who may answer
import { ChannelOf, ChannelRole, PauseAnswerer } from "@agboss/core";
import { RefundRequestDto } from "../dto/refund-request.dto.js";
import { RefundReplyInterpreter } from "../reply-interpreters/refund/refund.reply-interpreter.js";

@ChannelRole({
  name: "refund-approval-channel",
  description: "A manager approves refunds",
  approves: RefundRequestDto, // must be the input of every tool naming the role ([channel.wrong-tool])
  answerer: PauseAnswerer.Channel, // required: Slack authenticates who answers
  replyInterpreter: RefundReplyInterpreter, // one interpreter belongs to one role
})
export abstract class RefundApprovalChannel extends ChannelOf<RefundApprovalChannel> {}
```

```ts file=src/refunds/channels/slack-refund-approval.channel.ts
// channels/slack-refund-approval.channel.ts — the role's one implementation: infrastructure
import { Channel, ChannelOutcome, ExecutionContext, PauseClosedReason } from "@agboss/core";
import type { ChannelAsk, ChannelPauseClosedEvent } from "@agboss/core";
import { SlackClientService } from "../services/slack-client.service.js";
import { RefundApprovalChannel } from "./refund-approval.channel-role.js";

const AUTO_APPROVE_CENTS = 5000;

@Channel({
  name: "slack-refund-approval-channel",
  description: "Asks a manager in Slack; small refunds are approved at once",
  deps: [SlackClientService, ExecutionContext],
})
export class SlackRefundApprovalChannel extends RefundApprovalChannel {
  constructor(
    private readonly slackClientService: SlackClientService,
    private readonly executionContext: ExecutionContext,
  ) {
    super();
  }

  async send(ask: ChannelAsk<RefundApprovalChannel>): Promise<ChannelOutcome<RefundApprovalChannel>> {
    const { orderId, amountCents } = ask.value.arguments; // typed by RefundRequestDto
    if (amountCents <= AUTO_APPROVE_CENTS)
      return ChannelOutcome.decided({ approved: true, reason: "under the auto-approve limit" });
    const tenantId: string = this.executionContext.tenant.tenantId;
    // the pauseId is the reply key — and the idempotency key: a retried send gets the same one
    await this.slackClientService.postApproval(ask.pauseId, `Refund ${orderId} (${tenantId})?`);
    return ChannelOutcome.awaitReply();
  }

  // at least once, whenever a sent pause closes: answered elsewhere, cancelled, withdrawn, expired,
  // its tree ended — deduplicate by event.deliveryId (the same on every redelivery)
  override async onPauseClosed(event: ChannelPauseClosedEvent<RefundApprovalChannel>): Promise<void> {
    const why: string =
      event.reason === PauseClosedReason.Answered ? `answered by ${event.answeredBy ?? "?"}` : event.reason;
    await this.slackClientService.closeApproval(event.pauseId, why);
  }
}
```

```ts file=src/refunds/tools/refund.tool.ts
// tools/refund.tool.ts — names the role; runs only once a call is approved
import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { RefundApprovalChannel } from "../channels/refund-approval.channel-role.js";
import { RefundDoneDto } from "../dto/refund-done.dto.js";
import { RefundRequestDto } from "../dto/refund-request.dto.js";

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  input: RefundRequestDto,
  output: RefundDoneDto,
  channel: RefundApprovalChannel, // the role, never the implementation
  deps: [ExecutionContext],
})
export class RefundTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    return Promise.resolve({ refundId: `${orderId}:${this.executionContext.step.idempotencyKey}` });
  }
}
```

```ts file=src/environments/app.environment.ts
export class AppEnvironment {
  sqlitePath!: string; // the Sqlite* stores read it ([environment.missing-field] without it)
}
```

```ts file=src/environments/test.environment.ts
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = { sqlitePath: ":memory:" };
```

The agent, the workflow with its start and finish, the budgets and the application:

```ts file=src/refunds/agents/refund/refund.agent.ts
import { Agent } from "@agboss/core";
import { RefundTool } from "../../tools/refund.tool.js";

@Agent({
  name: "refund-agent",
  description: "Refunds orders on request",
  prompt: "Refund the order the customer names, with refund-tool.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
})
export class RefundAgent {}
```

```ts file=src/refunds/workflows/refund/refund.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "refund-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class RefundWorkflowStart {}
```

```ts file=src/refunds/workflows/refund/refund.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

@WorkflowFinish({ name: "refund-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class RefundWorkflowFinish {}
```

```ts file=src/refunds/workflows/refund/refund.workflow.ts
import { Workflow, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { RefundAgent } from "../../agents/refund/refund.agent.js";
import { SlackClientService } from "../../services/slack-client.service.js";
import { RefundWorkflowFinish } from "./refund.workflow-finish.js";
import { RefundWorkflowStart } from "./refund.workflow-start.js";

@Workflow({
  name: "refund-workflow",
  version: "1.0.0",
  flow: [
    start(RefundWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(RefundAgent)
      .toFinish(RefundWorkflowFinish),
  ],
  providers: [SlackClientService], // services in the workflow…
})
export class RefundWorkflow {}
```

```ts file=src/refunds/budgets/application-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}
```

```ts file=src/refunds/budgets/tenant-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}
```

```ts file=src/refunds/budgets/execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
```

```ts file=src/refunds.application.ts
import { Application, SqliteCheckpointSaver, SqlitePausedExecutionRepository } from "@agboss/core";
import { AppEnvironment } from "./environments/app.environment.js";
import { ApplicationDailyBudget } from "./refunds/budgets/application-daily.budget.js";
import { ExecutionBudget } from "./refunds/budgets/execution.budget.js";
import { TenantDailyBudget } from "./refunds/budgets/tenant-daily.budget.js";
import { SlackRefundApprovalChannel } from "./refunds/channels/slack-refund-approval.channel.js";
import { RefundWorkflow } from "./refunds/workflows/refund/refund.workflow.js";

@Application({
  name: "refunds-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [RefundWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  providers: [
    SlackRefundApprovalChannel, // …the channel implementation in the application
    SqlitePausedExecutionRepository, // pauses survive a restart: a durable pause store…
    SqliteCheckpointSaver, // …and a durable checkpointer, both
  ],
})
export class RefundsApplication {}
```

## Answering

<!-- snippet-context
import type { App } from "@agboss/core";
declare const app: App;
declare const pauseId: string;
-->

```ts
// the Slack webhook: the button's reply key is the pauseId the channel was sent
const result = await app.resume(
  { pauseId, decision: { approved: true } }, // a ToolCallApprovalDecisionDto, validated first
  { tenantId: "acme", answeredBy: "manager-17", record: true }, // Channel role → answeredBy (who answered)
);
console.log(result.status, result.pending.length, result.record?.pauses); // who answered what

// approve with corrected arguments, bypassing the model (only with approved: true)
await app.resume(
  { pauseId, decision: { approved: true, overrideArguments: { orderId: "7", amountCents: 900 } } },
  { tenantId: "acme", answeredBy: "manager-17" },
);

// a free-text reply, read by the role's reply interpreter
await app.resume({ pauseId, reply: "reject: duplicate" }, { tenantId: "acme", answeredBy: "manager-17" });
```

| `answerer` of the role      | `app.resume` takes                                       | Where the `pauseId` is              |
| --------------------------- | -------------------------------------------------------- | ----------------------------------- |
| `PauseAnswerer.ThreadOwner` | `ownerId` — the thread's owner (else `ThreadOwnerError`) | `result.pending[i].pauseId`         |
| `PauseAnswerer.Channel`     | `answeredBy` — non-empty, recorded                       | only in the channel's `ask.pauseId` |

The wrong credential for the role is `PauseAnswererError`. The contract of every channel is
`ChannelHandler<Role>` — `send(ask)` and the optional `onPauseClosed(event)` / `onPauseAnswerNotTaken(event)`;
a role's implementation gets it by extending the role (`ChannelOf<Role>` implements it, the notices no-ops you `override`). Ready-made concrete channels named on a
tool as is: `TerminalUserChannel` (answered in the terminal by `npx agboss chat` / `run`),
`AutoApproveChannel`, `AutoRejectChannel` (decide at once — scripts and tests).

## Questions: the workflow asks, the answer goes on the path

A **question role** (#659) is `@ChannelRole({ ask, answer, answerer })` — its name ends with
`-question` — and a flow step asks it: the step reads one `ask` value from the path, pauses on the
role's channel like an approval, and puts the typed `answer` on the path for the steps after it.

```ts file=src/purchases/dto/purchase.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class PurchaseDto {
  @Text({ prompt: "what is bought" })
  item!: string;

  @Integer({ prompt: "its price in dollars", min: 0 })
  priceUsd!: number;
}
```

```ts file=src/purchases/dto/spending-limit.dto.ts
import { Flag, Integer } from "@agboss/core/dto";

export class SpendingLimitDto {
  @Flag({ prompt: "whether the purchase may go on" })
  approved!: boolean;

  @Integer({ prompt: "the most it may cost, in dollars", min: 0 })
  limitUsd!: number;
}
```

```ts file=src/purchases/channels/spending-limit.channel-role.ts
// the question: what is asked, what answers it, who may answer
import { ChannelOf, ChannelRole, PauseAnswerer } from "@agboss/core";
import { PurchaseDto } from "../dto/purchase.dto.js";
import { SpendingLimitDto } from "../dto/spending-limit.dto.js";

@ChannelRole({
  name: "spending-limit-question", // a question role's name ends with -question
  description: "Asks the budget owner for this purchase's limit",
  ask: PurchaseDto,
  answer: SpendingLimitDto,
  answerer: PauseAnswerer.ThreadOwner, // the thread's owner answers, by the listed pauseId
  maxVisits: 3, // the step's limit when it is asked again on a cycle
})
export abstract class SpendingLimitQuestion extends ChannelOf<SpendingLimitQuestion> {}
```

```ts file=src/purchases/channels/slack-spending-limit.channel.ts
import { Channel, ChannelOutcome } from "@agboss/core";
import type { ChannelAsk } from "@agboss/core";
import { SlackClientService } from "../../refunds/services/slack-client.service.js";
import { SpendingLimitQuestion } from "./spending-limit.channel-role.js";

@Channel({ name: "slack-spending-limit-channel", description: "Asks in Slack", deps: [SlackClientService] })
export class SlackSpendingLimitChannel extends SpendingLimitQuestion {
  constructor(private readonly slackClientService: SlackClientService) {
    super();
  }

  async send(ask: ChannelAsk<SpendingLimitQuestion>): Promise<ChannelOutcome<SpendingLimitQuestion>> {
    const { item, priceUsd } = ask.value; // typed by the role's ask: PurchaseDto
    if (priceUsd <= 50) return ChannelOutcome.decided({ approved: true, limitUsd: 50 }); // the answer DTO
    await this.slackClientService.postApproval(ask.pauseId, `Limit for ${item} ($${String(priceUsd)})?`);
    return ChannelOutcome.awaitReply();
  }
}
```

```ts file=src/purchases/workflows/purchase/purchase.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { PurchaseDto } from "../../dto/purchase.dto.js";

@WorkflowStart({ name: "purchase-workflow-start", description: "A purchase", input: PurchaseDto })
export class PurchaseWorkflowStart {}
```

```ts file=src/purchases/workflows/purchase/purchase.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { SpendingLimitDto } from "../../dto/spending-limit.dto.js";

@WorkflowFinish({ name: "purchase-workflow-finish", description: "The limit", output: SpendingLimitDto })
export class PurchaseWorkflowFinish {}
```

```ts file=src/purchases/workflows/purchase/purchase.workflow.ts
import { Workflow, start } from "@agboss/core";
import { SpendingLimitQuestion } from "../../channels/spending-limit.channel-role.js";
import { PurchaseDto } from "../../dto/purchase.dto.js";
import { SpendingLimitDto } from "../../dto/spending-limit.dto.js";
import { SlackClientService } from "../../../refunds/services/slack-client.service.js";
import { PurchaseWorkflowFinish } from "./purchase.workflow-finish.js";
import { PurchaseWorkflowStart } from "./purchase.workflow-start.js";

@Workflow({
  name: "purchase-workflow",
  version: "1.0.0",
  flow: [
    start(PurchaseWorkflowStart)
      .returns(PurchaseDto) // the ask, on the path (an agent or an action may build it)
      .toQuestion(SpendingLimitQuestion) // pauses; .onError(QuestionFailedError, …) may follow
      .returns(SpendingLimitDto) // the typed answer: later steps read it like any value
      .toFinish(PurchaseWorkflowFinish),
  ],
  providers: [SlackClientService],
})
export class PurchaseWorkflow {}
```

The role's implementation (`SlackSpendingLimitChannel`) is listed in `@Application({ providers })`
and the workflow in its `workflows`, as for an approval. Answering: `app.resume({ pauseId, decision:
{ approved: true, limitUsd: 900 } }, { ownerId })` — validated as the role's `answer` DTO before it
is recorded — or `{ pauseId, reply: "up to 900" }`, read by the role's `replyInterpreter` into that
DTO (a chat model gets one answer tool, `answer-<answer dto>`, and the not-understood tool; a code
interpreter returns `ReplyInterpretation.understood(answer)`; a decision model cannot answer a
question, `[reply-interpreter.decision-model]`). `result.pending[i].kind` is `PauseKind.Question`,
`step` the question step, `ask` the masked question (opaque: read it after narrowing on `kind`, as
`const fields: Readonly<Record<string, unknown>> = pending.ask`). Exactly one answer wins (`PauseClosedError` for the
second), another instance continues it, a cancel withdraws it — as any pause. The step is no model
call and no step of `maxSteps`; the execution's budgets are checked before it asks. A tool that
names a question role is `[channel.wrong-tool]`.

A question may also start an `.onError` side path (#933): `.onError(StepFailedError,
toQuestion(DirectorQuestion).returns(DirectorAnswerDto)…)` — the failure is handled by asking, the
question reads its `ask` from the path as it stood before the failed step (field rules as for
`.toQuestion`), and its answer goes on the path. One role is one node: its `maxVisits` counts the
main path and the side path together. A side path that can catch a limit (`LimitExceededError`,
`BudgetExceededError`, a parent such as `AGBossError`) still leads only to actions and finishes —
a question there is `[graph.limit-handler-uses-model]` (a reply interpreter may call a model).

### An agent asks a question role as a tool (#712)

When the model should decide **whether** and **when** to ask, list the role in the agent's tools —
`@Agent({ …, tools: [SpendingLimitQuestion, PlaceOrderTool] })`. Its model sees a tool named the
role's name (`spending-limit-question`), described by the role's description, whose input is the
role's `ask` — validated strictly before anything is asked: arguments that are no valid ask (a
field the ask does not declare too) pause nothing and send nothing, the model reads a tool error
and may try again, and the call counts against the role's `maxVisits`; a valid call pauses on the role's channel at the loop's approval step, before the move's
other tools run (several question calls of one move are asked one after the other), and the role's
`answer` — a `decision`, a reply its interpreter read, or the channel's `decided(…)`, validated as
the `answer` DTO — is the call's result the model reads next (through the tool-result path: PII
masking of the answer's `sensitive` fields, `maxResultSize`, `onToolStart` / `onToolEnd`,
`result.toolCalls` with `step.component.kind` `question`; tool interceptors do not apply — the call
runs no tool). `result.pending[i]` is `kind: PauseKind.Question`, `step` the asking agent,
`channel` the role; every guarantee of a question step holds (one answer wins, another instance
resumes it without asking again, a cancel withdraws it, tenant and owner checks). The role's
`maxVisits` bounds how many times one visit of the agent asks it (the next call fails the step with
`VisitsLimitExceededError` before it is asked); the budgets and the holder's fence are checked
before every ask. A `send` that throws, or an invalid `decided(…)`, fails the agent's step
(`AgentFailedError`, the cause kept). An approval role in `tools` is
`[channel.approval-role-as-tool]`. Tests script the call as `callTool(SpendingLimitQuestion, { item,
priceUsd })` (typed by the role's ask); `agboss describe` prints `asked at <agent>'s tool loop
(<workflow>)`.

## The pause's life and its records

- **`PendingPause`** (`result.pending`): `kind` (`PauseKind.Approval` | `PauseKind.Question`),
  `pauseId?` (ThreadOwner roles only), `answerer`, `step` (the agent whose call waits, or the
  question step), `channel`, `ask` (an approval's `ToolCallApprovalAskDto`: `tool`, `arguments`,
  `summary`, `callId`; a question's `QuestionAsk` — its ask DTO, `sensitive` fields masked,
  opaque), `itemIndex`, `childExecutionId` (a pause in a child workflow is the root's); the fields
  every kind has are `PendingPauseBase`. Narrow on `kind` before reading `ask`: `pending[0].ask.arguments`
  does not compile until `pending[0].kind === PauseKind.Approval`. Parallel branches pause on their own; the execution rests when nothing else can move,
  and answering one continues it while the rest keep waiting.
- **`PauseStatus`**: `Pending` → `Resolved` (an answer recorded, atomically) → `Taken` (its step went
  on), or `Cancelled` (withdrawn, cancelled, its tree ended — an answer no step took is closed _not taken_).
  An answer to anything but `Pending` → `PauseClosedError` with its `reason` and `closedAt` (a double
  click: `answered`; over A2A `-32004` with `code: a2a.pause-closed`); `NotPausedError` stays for the thread-level paths
  only (a thread with no paused run); an unknown id or another tenant's → `UnknownPauseError`. Resolved records are kept
  `@Application({ retention: { pauseRecords: hours(24) } })`, then removed by the recovery sweep.
- **`PauseAnswerRecord`** (`result.record.pauses`, with `{ record: true }`) — the permanent history:
  `pauseId`, `executionId`, `step`, `role`, `answerer`, `answeredBy` (`responder`, deprecated), `resolution`
  (`PauseResolution.Decided` | `Replied` | `Withdrawn` | `Cancelled`), `askedAt`, `resolvedAt`, the
  masked `decision`. A child's own are in its `ChildExecutionRecord.pauses`.
- **`onPauseClosed(event)`** (`ChannelPauseClosedEvent`: `pauseId`, `value`, `reason`
  (`PauseClosedReason.Answered` | `Expired` | `Cancelled` | `Withdrawn` | `TreeEnded`), `closedAt`,
  `answeredBy?`, the masked `answer?`, `deliveryId`) is called **at least once** whenever a pause the
  channel sent closes — written with the close, delivered after a crash by any instance, in order,
  in the pause's frame under the tool's `timeout`; `onPauseAnswerNotTaken` when its recorded answer
  was never applied. A channel that overrides neither has no mailbox. A throw is retried with
  growing pauses (`pause.notice-failed`) and set aside after `retention.pauseRecords`
  (`pause.notice-dead`); it never fails a run, a resume or a cancel. `deliveryId` is the dedupe key.
- **`@PauseListener({ name: "back-office-pause-listener", deps, allowAnswering? })`** — an
  application-wide `PauseListenerHandler` (`onPauseOpened`, `onPauseClosed`, optional
  `onPauseAnswerNotTaken`), listed in `@Application({ providers })`, one instance created at start,
  hearing every pause of every workflow with the same guarantees. It gets `pauseKey`, never the
  answering `pauseId` of a channel pause unless `allowAnswering: true` (a trusted component: it holds
  the right to answer every channel pause); asks and answers are masked. Rules:
  `[name.kind-suffix]`, `[pause-listener.duplicate-name]`, `[pause-listener.not-a-handler]`.
- **A model interpreter** (`DecidedBy.Model`, a chat model) gets the role's answer tool, its
  `overrideArguments` described by the approved tool's input with every field optional — "ok but
  only up to $500" is `{ approved: true, overrideArguments: { amountUsd: 500 } }`, laid over the
  call's own arguments — and `answer-reply-interpreter-not-understood-dto` for a reply that does not
  answer ("🤷"), which is never a refusal (#648). Tests:
  `replyWith(ReplyInterpreterNotUnderstoodDto, { reason })`. For an approval role (#688) its decision
  is named — `approve` / `approve-with-changes` / `refuse`; an unknown one, `approve-with-changes`
  without a correction, `approved` beside a decision or a correction that changes the call's shape
  (a new key at any depth, another kind of value, a list of another length) is not understood, and
  the corrected call passes the tool's own input strictly (an unknown key is refused). The kept
  record's `PauseAnswerRecord.asked` is the call as asked, beside its `decision`.
- **A reply interpreter may change approved arguments within the call's DTO; put money limits in a
  guardrail or the action.** A reply interpreter reads intent; it is not a guardrail (#688). It does not decide whether a
  correction is allowed — "never above the call's amount", "only in the call's currency", "never
  below 0". Put such a limit where it holds whoever approved the call: a tool interceptor's
  `beforeToolCall` on the call as it runs (after the approval, with any correction —
  `ToolCallDecision.block({ reason })` fails the step with `ToolBlockedError`), or a check in the
  tool's or action's own code (`min` / `max` on the input DTO's field for a plain bound). The
  payment guarantees — fenced effects, outbound calls, one charge per business key — hold whatever
  the interpreter reads.
- **Free text** that cannot be read throws `UninterpretableReplyError` (`pause.uninterpretable-reply`,
  `reason`) and the pause stays `Pending`; a role without `replyInterpreter` →
  `ReplyInterpreterMissingError`. Exactly one of `decision` / a non-empty `reply`, else
  `DtoValidationError`.
- **A deadline for the answer** (#941): `@ChannelRole({ expiresIn: hours(24) })` — at least
  `seconds(1)` — gives every pause of the role an absolute deadline, fixed when the pause is made (a
  deploy that changes `expiresIn` never moves an open pause); `.toQuestion(Role, { expiresIn })` (and
  the side path `toQuestion(Role, { expiresIn })`) overrides it for a question step (one value per
  node: `[question.expires-in-conflict]`), `@Tool({ channel, expiresIn })` for a tool
  (`[tool.expires-in-without-channel]`, `[channel.expires-in-invalid]`); a run's deadline bounds
  every pause too, the smaller wins and a tie goes to the run. `result.pending[].expiresAt` shows it.
  The deadline is **hard**: an answer at or after it is `PauseClosedError` (`reason: expired`,
  `closedAt` the deadline), decided atomically in the store — an answer and the expiry racing: one
  wins. Within seconds the tree is taken and the channel's optional
  `onPauseExpired(ask)` (`implements PauseExpiryHandler<Role>`, the `ask` as `send` got it) says what
  the expiry means: `PauseExpiration.fail()` — the step fails with `PauseExpiredError`
  (`step.pause-expired`, `step`, `stepKind`, `channel`, `kind`, `expiresAt`; `.onError(PauseExpiredError, …)`
  escalates; an agent's approval or question call fails the whole agent step, its spend kept) — or
  `PauseExpiration.decide(answer)` — the step goes on with that answer, validated like a resume's,
  recorded as answered by the channel (`PauseResolution.DecidedOnExpiry`, `ResumeReason.Expired`;
  `decide({ approved: true })` runs the tool with no person having looked: choose it knowing that).
  Without the method the expiry is `fail()`. The handler runs once per expiry — again only after a
  crash before its decision was recorded — so it must only read; a throw, a hang past the tool's
  `timeout`, a value that is no expiration or an invalid answer fails the expiry with an
  `ExpiryHandlerError` as the cause (`pause.expiry-handler-failed` warned, never the error's message).
  A pause the run's deadline bound fails the run with `DeadlineExceededError` and asks the channel
  nothing. `app.cancel` always beats an expiry (the pause is closed `expired`, the run cancelled).
  Over A2A the task goes `WORKING`, then `FAILED` (`step.pause-expired`) or `COMPLETED`; a follow-up
  before the look is `-32004 a2a.pause-closed` `reason: expired`. Reminders and extensions are #942.
- `app.cancel(threadId, { tenantId })` withdraws a paused thread's pauses (the channel's `onPauseClosed` is
  told, `PauseClosedReason.Cancelled`).

## Testing a pause

<!-- snippet-context
import { ChannelOutcome } from "@agboss/core";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { expect } from "vitest";
import { RefundsApplication } from "./src/refunds.application.js";
import { RefundAgent } from "./src/refunds/agents/refund/refund.agent.js";
import { RefundWorkflowFinish } from "./src/refunds/workflows/refund/refund.workflow-finish.js";
import { RefundWorkflowStart } from "./src/refunds/workflows/refund/refund.workflow-start.js";
import { SlackRefundApprovalChannel } from "./src/refunds/channels/slack-refund-approval.channel.js";
import { RefundTool } from "./src/refunds/tools/refund.tool.js";
-->

```ts
const test = testWith(RefundsApplication);

test("a large refund waits for the manager, then runs", async ({ app, mockLlm, mockOf }) => {
  mockOf(SlackRefundApprovalChannel).send.mockResolvedValue(ChannelOutcome.awaitReply());
  mockLlm(RefundAgent).thenReturn(
    callTool(RefundTool, { orderId: "7", amountCents: 90_000 }),
    replyWith("Refunded order 7."),
  );

  const paused = await app.execute(RefundWorkflowStart, { text: "refund order 7" });
  expect(paused.pending).toHaveLength(1);
  const [ask] = mockOf(SlackRefundApprovalChannel).send.mock.calls[0] ?? [];

  const done = await app.resume(
    { pauseId: ask?.pauseId ?? "", decision: { approved: true } },
    { answeredBy: "manager-17" },
  );
  expect(done).toFinishWith(RefundWorkflowFinish, { text: "Refunded order 7." });
});
```

- `mockOf(Implementation).send.mockResolvedValue(ChannelOutcome.decided({ approved: true }))` decides
  at once; `testWith(App, { overrides: [override(RefundApprovalChannel, AutoApproveChannel)] })`
  replaces the role's implementation for the whole test.
- A model reply interpreter is scripted by its input: `mockLlm(Interpreter).when({ reply: "ok" })
.thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true }))`; one on a decision model
  with `decideWith({ approved: 0.9 })`.

## Rule codes and errors

| Code / error                              | Cause → fix                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `[channel.wrong-tool]`                    | the role's `approves` is not the tool's `input` → make them the same DTO                                                           |
| `[channel.wrong-tool]` (question)         | a tool names a question role → ask it with `.toQuestion(Role)`                                                                     |
| `[channel.role-form]`                     | both `approves` and `ask` / `answer`, or half a question → one form                                                                |
| `[reply-interpreter.decision-model]`      | a question role's interpreter on a decision model → a chat model, or `DecidedBy.Code`                                              |
| `QuestionFailedError`                     | a question's `send` threw or `decided(…)` was not the answer DTO (`step.question`, `question`) → `.onError`                        |
| `PauseExpiredError`                       | a pause's deadline passed with no answer (`step.pause-expired`) → `.onError(PauseExpiredError, …)`, or `PauseExpiration.decide(…)` |
| `[channel.expires-in-invalid]`            | a role's, tool's or question step's `expiresIn` is under `seconds(1)` or no finite duration → `hours(4)`                           |
| `[tool.expires-in-without-channel]`       | `@Tool({ expiresIn })` with no `channel` → add `channel`, or drop `expiresIn`                                                      |
| `[question.expires-in-conflict]`          | two `.toQuestion(Q, …)` edges to one question with different `expiresIn` → one value                                               |
| `[di.missing-implementation]`             | a role named on a tool, no `@Channel` that `extends` it listed → list one in the application                                       |
| `[di.ambiguous-implementation]`           | two implementations of one role → keep one (one per application)                                                                   |
| `[di.infrastructure-in-workflow]`         | the implementation in `@Workflow({ providers })` → `@Application({ providers })`                                                   |
| `[channel.shared-interpreter]`            | one `@ReplyInterpreter` on two roles → one each                                                                                    |
| `[reply-interpreter.no-interpret-method]` | a code interpreter without `interpret` → add it                                                                                    |
| `[application.in-memory-pauses]`          | pauses possible on the in-memory stores (a warning; an error under `--strict`) → list durable ones                                 |
| `PauseAnswererError`                      | `ownerId` for a Channel role or `answeredBy` for a ThreadOwner role → the other credential                                         |
| `IncompatibleResumeError`                 | resumed on an app with another config hash → `WorkflowSettings.builder().onIncompatibleResume(…)`                                  |

## Pitfalls

- Naming the implementation on the tool (`channel: SlackRefundApprovalChannel`): name the role.
- Reading the `pauseId` from `result.pending` for a `Channel` role — it is not there by design; the
  channel gets it in `ask.pauseId` and is its reply key.
- A channel that sleeps until an answer: return `awaitReply()` and let `app.resume` continue it.
- Pauses on the in-memory stores in production: they vanish on restart.
