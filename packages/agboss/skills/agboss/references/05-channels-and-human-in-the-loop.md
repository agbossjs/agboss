# 05 — Channels and human in the loop

Read this when a tool call must be approved by a person or a system before it runs, when a
workflow asks a person a typed question and goes on with the answer (an external task, #659), when an
execution pauses and is answered later (`app.resume`), or when a reply arrives as free text.
Tools themselves: `03-components-di-and-lifecycle.md`; durable stores: `09-persistence-k8s-and-deploy.md`.

## How a pause works

A pause waits under a **pause target** — what is asked, who may answer, for how long. The
**channel** is only the transport that tells the people.

1. A `@Tool({ approval })` names an **approval target** — an empty class
   `@ToolApproval({ name, description, input, respondent, timeout })` (named `…-tool-approval`).
   A flow step asks an **external task** instead — an empty class
   `@ExternalTask({ name, description, input, output, respondent, timeout })` (named
   `…-external-task`). `respondent` is required: `PauseRespondent.Owner` (the thread's owner
   answers, by the `pauseId` in `result.pending`) or `PauseRespondent.Delegate` (someone the
   channel authenticates answers, by the `pauseId` only the channel knows).
2. Before every call of that tool the framework creates a pause record (`PausedExecutionRepository`,
   keyed by the step's idempotency key) and calls the target's channel — a class
   `@Channel({ name, description, target, ttl })` listed in `@Application({ channels })`, with
   `send(ask: ChannelAsk<Target>)`; `ask = { pauseId, input, … }` (`ask.input` typed by the target's
   `input`). An `Owner` target with no channel asks nobody and waits for `app.resume`.
3. `send` returns `ChannelOutcome.decided(decision)` (go on at once — a rule decided) or
   `ChannelOutcome.awaitReply()` (the execution rests, `result.status === ExecutionStatus.Paused`,
   `result.pending: PendingPause[]`).
4. Later, a webhook, a CLI or a scheduler answers by the pause's id: `app.resume({ pauseId,
decision }, { tenantId, actor | ownerId })` — or with free text, `{ pauseId, reply }`, read
   by the target's `@ChannelInterpreter`. Approved → the tool runs once (with `overrideInput` if
   given); rejected → the model reads `Tool error: the call was rejected …` and goes on.

A pause is a tool call through a channel — or an **external task** of the flow,
`.toExternalTask(Task)` (below: Questions). Nothing waits in memory — a pause survives a
restart when the application's storage is durable (`@DatabaseStorage`).

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
// free text → a decision, by code (a @ChannelInterpreter with a prompt and a model reads it by a chat model instead)
import { ChannelInterpretation, ChannelInterpreter } from "@agboss/core";
import type { ChannelInterpreterHandler, InputOf, OutputOf } from "@agboss/core";

@ChannelInterpreter({
  name: "refund-reply-interpreter",
  description: "Reads a manager's Slack reply to a refund",
})
export class RefundReplyInterpreter
  implements ChannelInterpreterHandler<RefundReplyInterpreter>
{
  interpret(
    input: InputOf<RefundReplyInterpreter>, // { ask: the approval's input, reply: the text }
  ): ChannelInterpretation<OutputOf<RefundReplyInterpreter>> {
    const reply: string = input.reply.trim().toLowerCase();
    if (reply === "approve") return ChannelInterpretation.understood({ approved: true });
    if (reply.startsWith("reject"))
      return ChannelInterpretation.understood({ approved: false, reason: reply });
    return ChannelInterpretation.notUnderstood(`not "approve" or "reject …": ${input.reply}`);
  }
}
```

```ts file=src/refunds/tool-approvals/refund.tool-approval.ts
// the target: what is approved, who may answer, for how long — no transport here
import { PauseRespondent, ToolApproval } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { RefundRequestDto } from "../dto/refund-request.dto.js";
import { RefundReplyInterpreter } from "../reply-interpreters/refund/refund.reply-interpreter.js";

@ToolApproval({
  name: "refund-tool-approval",
  description: "A manager approves refunds",
  input: RefundRequestDto, // the input of every tool naming it ([channel.wrong-tool] otherwise)
  respondent: PauseRespondent.Delegate, // required: Slack authenticates who answers
  timeout: hours(24), // a hard deadline, fixed when the pause is made
  remindBefore: hours(2), // the channel hears onPauseExpiring two hours before it
  channelInterpreter: RefundReplyInterpreter, // reads a free-text reply
})
export class RefundToolApproval {}
```

```ts file=src/refunds/channels/slack-refund.channel.ts
// the target's channel: infrastructure only
import { Channel, ChannelOutcome, ExecutionContext, PauseClosedReason } from "@agboss/core";
import type { ChannelAsk, ChannelPauseClosedEvent } from "@agboss/core";
import { days } from "@agboss/core/units";
import { SlackClientService } from "../services/slack-client.service.js";
import { RefundToolApproval } from "../tool-approvals/refund.tool-approval.js";

const AUTO_APPROVE_CENTS = 5000;

@Channel({
  name: "slack-refund-channel",
  description: "Asks a manager in Slack; small refunds are approved at once",
  target: RefundToolApproval,
  ttl: days(7), // how long a closed pause's record is kept for this channel's notices
  deps: [SlackClientService, ExecutionContext],
})
export class SlackRefundChannel {
  constructor(
    private readonly slackClientService: SlackClientService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async send(ask: ChannelAsk<RefundToolApproval>): Promise<ChannelOutcome<RefundToolApproval>> {
    const { orderId, amountCents } = ask.input; // typed by RefundRequestDto
    if (amountCents <= AUTO_APPROVE_CENTS)
      return ChannelOutcome.decided({ approved: true, reason: "under the auto-approve limit" });
    const tenantId: string = this.executionContext.tenant.tenantId;
    // the pauseId is the reply key — and the idempotency key: a retried send gets the same one
    await this.slackClientService.postApproval(ask.pauseId, `Refund ${orderId} (${tenantId})?`);
    return ChannelOutcome.awaitReply();
  }

  // at least once, whenever a sent pause closes: answered elsewhere, cancelled, withdrawn, expired,
  // its tree ended — deduplicate by event.deliveryId (the same on every redelivery)
  async onPauseClosed(event: ChannelPauseClosedEvent<RefundToolApproval>): Promise<void> {
    const why: string =
      event.reason === PauseClosedReason.Answered ? `answered by ${event.actor?.id ?? "?"}` : event.reason;
    await this.slackClientService.closeApproval(event.pauseId, why);
  }
}
```

```ts file=src/refunds/tools/refund.tool.ts
// names the target; runs only once a call is approved
import { ExecutionContext, Tool } from "@agboss/core";
import { RefundToolApproval } from "../tool-approvals/refund.tool-approval.js";
import { RefundDoneDto } from "../dto/refund-done.dto.js";
import { RefundRequestDto } from "../dto/refund-request.dto.js";

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  input: RefundRequestDto,
  output: RefundDoneDto,
  approval: RefundToolApproval, // the target, never the channel
  deps: [ExecutionContext],
})
export class RefundTool {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    return Promise.resolve({ refundId: `${orderId}:${this.executionContext.step.idempotencyKey}` });
  }
}
```

The model provider, the agent, the workflow with its start and finish, the budgets, the storage
and the application:

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

```ts file=src/refunds/agents/refund/refund.agent.ts
import { Agent, inline } from "@agboss/core";
import { RefundTool } from "../../tools/refund.tool.js";

@Agent({
  name: "refund-agent",
  description: "Refunds orders on request",
  prompt: inline("Refund the order the customer names, with refund-tool."),
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
import { Workflow, onStart, Ttl } from "@agboss/core";
import { RefundAgent } from "../../agents/refund/refund.agent.js";
import { SlackClientService } from "../../services/slack-client.service.js";
import { RefundWorkflowFinish } from "./refund.workflow-finish.js";
import { RefundWorkflowStart } from "./refund.workflow-start.js";

@Workflow({
  name: "refund-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RefundWorkflowStart)
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

```ts file=src/refunds/storages/refunds.database-storage.ts
// pauses survive a restart: a durable database storage
import { DatabaseStorage, SqliteDriver, defineEnv, env } from "@agboss/core";
import { hours } from "@agboss/core/units";

const databaseEnv = defineEnv({
  path: env("AGBOSS_SQLITE_PATH", { default: ".agboss/refunds.sqlite" }),
});

@DatabaseStorage({
  name: "refunds-database-storage",
  driver: SqliteDriver({ path: databaseEnv.path }),
  auditLogTtl: hours(24 * 7),
  ledgerEntriesTtl: hours(24),
})
export class RefundsDatabaseStorage {}
```

```ts file=src/refunds.application.ts
import { Application, EmptyEnvironment } from "@agboss/core";
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";
import { ApplicationDailyBudget } from "./refunds/budgets/application-daily.budget.js";
import { ExecutionBudget } from "./refunds/budgets/execution.budget.js";
import { TenantDailyBudget } from "./refunds/budgets/tenant-daily.budget.js";
import { SlackRefundChannel } from "./refunds/channels/slack-refund.channel.js";
import { RefundsDatabaseStorage } from "./refunds/storages/refunds.database-storage.js";
import { RefundWorkflow } from "./refunds/workflows/refund/refund.workflow.js";

@Application({
  name: "refunds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RefundWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  storage: RefundsDatabaseStorage, // pauses survive a restart (in-memory is an assembly warning)
  modelProvider: OpenRouterModelProvider, // explicit: every chat model of the application
  providers: [OpenRouterModelProvider],
  channels: [SlackRefundChannel], // a target's channel is listed here, never in a workflow
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
  { tenantId: "acme", actor: { id: "manager-17" }, includeRecord: true }, // Delegate target → actor (who answered)
);
console.log(result.status, result.pending.length, result.record?.pauses); // who answered what

// approve with corrected arguments, bypassing the model (only with approved: true)
await app.resume(
  { pauseId, decision: { approved: true, overrideInput: { orderId: "7", amountCents: 900 } } },
  { tenantId: "acme", actor: { id: "manager-17" } },
);

// a free-text reply, read by the target's channel interpreter
await app.resume({ pauseId, reply: "reject: duplicate" }, { tenantId: "acme", actor: { id: "manager-17" } });
```

| `respondent` of the target | `app.resume` takes                                                         | Where the `pauseId` is              |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| `PauseRespondent.Owner`    | `ownerId` — the thread's owner (else `ExecutionError.ThreadOwnerMismatch`) | `result.pending[i].pauseId`         |
| `PauseRespondent.Delegate` | `actor` — non-empty, recorded                                              | only in the channel's `ask.pauseId` |

`respondent` is who _may_ answer; `actor` is who _did_ (a `PauseActor`, kept on the pause, its answer
record and its trail). The wrong credential for the target is `PauseError.PermissionDenied`. The
contract of every channel is `ChannelHandler<Target>` — `send(ask)` and the optional
`onPauseClosed(event)` / `onPauseAnswerNotTaken(event)` / `onPauseTimeoutChanged(event)` /
`onPauseExpiring(event)` / `onPauseJoinFailed(event)` / `onPauseReassigned(event)`; a channel is a plain class with
`send` (no base class to extend), so it takes only the hooks it needs. Ready-made channels for scripts
and tests decide at once: `AutoApproveChannel.for(Target)`, `AutoRejectChannel.for(Target)`. An approval
the thread's owner answers needs no channel: a `@ToolApproval` with `PauseRespondent.Owner` and no
`@Channel`, answered in the terminal by `npx agboss chat` / `run` or by `app.resume`. A target with
several channels names a `@ChannelSelector({ target })` class (listed in `@Application({ channelSelectors })`) whose `selectChannel(ctx)` picks one
when a pause is made (`[channel.ambiguous-for-target]` without it).

`app.listPauses({ tenantId, target, status, expiringBefore })` pages the pauses of one target by its
`name` (`PausesPage`).

## Questions: the workflow asks, the answer goes on the path

An **external task** (#659) is `@ExternalTask({ name, description, input, output, respondent, timeout })`
on an empty class — its name ends with `-external-task` — and a flow step asks it:
`.toExternalTask(Task)` reads one `input` value from the path, pauses on the task's channel like an
approval, and puts the typed `output` on the path for the steps after it.

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
import { Bool, Integer } from "@agboss/core/dto";

export class SpendingLimitDto {
  @Bool({ prompt: "whether the purchase may go on" })
  approved!: boolean;

  @Integer({ prompt: "the most it may cost, in dollars", min: 0 })
  limitUsd!: number;
}
```

```ts file=src/purchases/external-tasks/spending-limit.external-task.ts
// the task: what is asked, what answers it, who may answer, for how long
import { ExternalTask, PauseRespondent } from "@agboss/core";
import { days } from "@agboss/core/units";
import { PurchaseDto } from "../dto/purchase.dto.js";
import { SpendingLimitDto } from "../dto/spending-limit.dto.js";

@ExternalTask({
  name: "spending-limit-external-task", // a task's name ends with -external-task
  description: "Asks the budget owner for this purchase's limit",
  input: PurchaseDto,
  output: SpendingLimitDto,
  respondent: PauseRespondent.Owner, // the thread's owner answers, by the listed pauseId
  timeout: days(3),
  maxVisits: 3, // the step's limit when it is asked again on a cycle
})
export class SpendingLimitExternalTask {}
```

```ts file=src/purchases/channels/slack-spending-limit.channel.ts
import { Channel, ChannelOutcome } from "@agboss/core";
import type { ChannelAsk } from "@agboss/core";
import { days } from "@agboss/core/units";
import { SlackClientService } from "../../refunds/services/slack-client.service.js";
import { SpendingLimitExternalTask } from "../external-tasks/spending-limit.external-task.js";

@Channel({
  name: "slack-spending-limit-channel",
  description: "Asks in Slack",
  target: SpendingLimitExternalTask,
  ttl: days(7),
  deps: [SlackClientService],
})
export class SlackSpendingLimitChannel {
  constructor(private readonly slackClientService: SlackClientService) {}

  async send(ask: ChannelAsk<SpendingLimitExternalTask>): Promise<ChannelOutcome<SpendingLimitExternalTask>> {
    const { item, priceUsd } = ask.input; // typed by the task's input: PurchaseDto
    if (priceUsd <= 50) return ChannelOutcome.decided({ approved: true, limitUsd: 50 }); // the output DTO
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
import { Workflow, onStart, Ttl } from "@agboss/core";
import { SpendingLimitExternalTask } from "../../external-tasks/spending-limit.external-task.js";
import { PurchaseWorkflowFinish } from "./purchase.workflow-finish.js";
import { PurchaseWorkflowStart } from "./purchase.workflow-start.js";

@Workflow({
  name: "purchase-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PurchaseWorkflowStart) // the input, on the path (an agent or an action may build it)
      .toExternalTask(SpendingLimitExternalTask) // pauses; .onError(StepError.ExternalTask, …) may follow
      .toFinish(PurchaseWorkflowFinish), // the typed output: later steps read it like any value
  ],
})
export class PurchaseWorkflow {}
```

The task's channel (`SlackSpendingLimitChannel`) is listed in `@Application({ channels })` and the
workflow in its `workflows`, as for an approval. Answering: `app.resume({ pauseId, decision:
{ approved: true, limitUsd: 900 } }, { ownerId })` — validated as the task's `output` DTO before it
is recorded — or `{ pauseId, reply: "up to 900" }`, read by the task's `channelInterpreter` into that
DTO (a model interpreter — `@ChannelInterpreter({ prompt, model? })` with no class body — gets one
answer tool, `answer-<output dto>`, and the not-understood tool; a code interpreter returns
`ChannelInterpretation.understood(output)`; a decision model cannot answer a task,
`[reply-interpreter.decision-model]`). `result.pending[i].kind` is `PauseKind.ExternalTask`,
`step` the task's step, `input` the masked question (opaque: read it after narrowing on `kind`, as
`const fields: Readonly<Record<string, unknown>> = pending.input`). Exactly one answer wins
(`PauseError.Closed` for the second), another instance continues it, a cancel withdraws it — as any
pause. The step is no model call and no step of `maxSteps`; the execution's budgets are checked
before it asks. A tool that names an external task as its `approval` is `[channel.wrong-tool]`.

A task may also start an `.onError` side path (#933): `.onError(StepError,
toExternalTask(DirectorExternalTask)…)` — the failure is handled by asking, the task reads its
input from the path as it stood before the failed step (field rules as for `.toExternalTask`), and
its output goes on the path. One task is one node: its `maxVisits` counts the main path and the side
path together. A side path that can catch a limit (`LimitError`, `LimitError.Budget`, a
parent such as `AGBossError`) still leads only to actions and finishes — a task there is
`[graph.limit-handler-uses-model]` (a reply interpreter may call a model).

An `@ExternalTask` is also a branch of a parallel launch (#1306): `.inParallel([toExternalTask(Legal),
toExternalTask(Security), …])` asks a committee at once, `.forEachItem(toExternalTask(Owner), { maxItems })`
one task per item; an arbiter counts the answers.

### An agent asks an external task as a tool (#712)

When the model should decide **whether** and **when** to ask, list the task in the agent's tools —
`@Agent({ …, tools: [SpendingLimitExternalTask, PlaceOrderTool] })`. Its model sees a tool named the
task's name (`spending-limit-external-task`), described by the task's description, whose input is the
task's `input` — validated strictly before anything is asked: arguments that are no valid input (a
field the input does not declare too) pause nothing and send nothing, the model reads a tool error
and may try again, and the call counts against the task's `maxVisits`; a valid call pauses on the
task's channel at the loop's approval step, before the move's other tools run (several calls of one
move are asked one after the other), and the task's `output` — a `decision`, a reply its interpreter
read, or the channel's `decided(…)`, validated as the `output` DTO — is the call's result the model
reads next (through the tool-result path: PII masking of the output's `sensitive` fields,
`maxResultSize`, `onToolStart` / `onToolEnd`, `result.toolCalls`; tool interceptors do not apply —
the call runs no tool). `result.pending[i]` is `kind: PauseKind.ExternalTask`, `step` the asking
agent, `target` the task; every guarantee of an external-task step holds (one answer wins, another
instance resumes it without asking again, a cancel withdraws it, tenant and owner checks). The task's
`maxVisits` bounds how many times one visit of the agent asks it (the next call fails the step with
`LimitError.Visits` before it is asked); the budgets and the holder's fence are checked
before every ask. A `send` that throws, or an invalid `decided(…)`, fails the agent's step
(`StepError.Agent`, the cause kept). A `@ToolApproval` in `tools` is
`[channel.approval-role-as-tool]`. Tests script the call as `callTool(SpendingLimitExternalTask, { item,
priceUsd })` (typed by the task's input); `agboss describe` prints `asked at <agent>'s tool loop
(<workflow>)`.

## The pause's life and its records

- **`PendingPause`** (`result.pending`): `kind` (`PauseKind.Approval` | `PauseKind.ExternalTask`),
  `pauseId?` (`Owner` targets only), `respondent`, `step` (the agent whose call waits, or the
  task's step), `target` (the pause target's name), `channel?` (absent for an owner's target with none),
  `input` (an approval's tool arguments, or a task's input DTO, `sensitive` fields masked, as
  `Readonly<Record<string, unknown>>`), `toolCall` (an approval's `{ callId, tool, summary? }`),
  `assignees?`, `externalRef?`, `trail`, `itemIndex`, `childExecutionId` (a pause in a child workflow is the root's); the fields
  every kind has are `PendingPauseBase`. Narrow on `kind` before reading `toolCall`: `pending[0].toolCall`
  does not compile until `pending[0].kind === PauseKind.Approval`. Parallel branches pause on their own; the execution rests when nothing else can move,
  and answering one continues it while the rest keep waiting.
- **`PauseStatus`**: `Pending` → `Resolved` (an answer recorded, atomically) → `Taken` (its step went
  on), or `Cancelled` (withdrawn, cancelled, its tree ended — an answer no step took is closed _not taken_).
  An answer to anything but `Pending` → `PauseError.Closed` with its `reason` and `closedAt` (a double
  click: `answered`; over A2A `-32004` with `code: a2a.pause-closed`); `NotPausedError` stays for the thread-level paths
  only (a thread with no paused run); an unknown id or another tenant's → `PauseError.UnknownPause`. Resolved records are kept
  `@Application({ retention: { pauseRecords: hours(24) } })`, then removed by the recovery sweep.
- **`PauseAnswerRecord`** (`result.record.pauses`, with `{ includeRecord: true }`) — the permanent history:
  `pauseId`, `executionId`, `step`, `target`, `channel?`, `respondent`, `actor`, `resolution`
  (`PauseResolution.Decided` | `Replied` | `Withdrawn` | `Cancelled`), `askedAt`, `resolvedAt`, the
  masked `decision`, `trail`. A child's own are in its `ChildExecutionRecord.pauses`. A pause record a
  0.1.0 build wrote has no `target` and is refused (`StoreError.UnreadableRecord`), never read.
- **`onPauseClosed(event)`** (`ChannelPauseClosedEvent`: `pauseId`, `input`, `reason`
  (`PauseClosedReason.Answered` | `Expired` | `Cancelled` | `Withdrawn` | `TreeEnded` | `Reassigned`), `closedAt`,
  `actor?`, the masked `answer?`, `deliveryId`) is called **at least once** whenever a pause the
  channel sent closes — written with the close, delivered after a crash by any instance, in order,
  in the pause's frame under the tool's `timeout`; `onPauseAnswerNotTaken` when its recorded answer
  was never applied. A channel that has none of the hooks has no mailbox. A throw is retried with
  growing pauses (`pause.notice-failed`) and set aside after `retention.pauseRecords`
  (`pause.notice-dead`); it never fails a run, a resume or a cancel. `deliveryId` is the dedupe key.
- **`@ChannelListener({ name, deps?, includePauseIds? })`** — an application-wide class with
  the hooks it needs (`ChannelListenerHandler`: `onPauseOpened`, `onPauseClosed`,
  `onPauseAnswerNotTaken`, `onPauseExpiring`, `onPauseTimeoutChanged`, `onPauseReassigned`,
  `onPauseJoinFailed`), listed in `@Application({ channelListeners })`, one instance created at start, hearing
  every pause of every workflow with the same guarantees. Its events (`ChannelListenerExpiringEvent`,
  `ChannelListenerTimeoutChangedEvent`, `ChannelListenerJoinFailedEvent`, …) carry the `pauseKey`, `target`,
  `channel?` and `respondent`, never the answering `pauseId` of a delegate's pause unless
  `includePauseIds: true` (a trusted component: it holds the right to answer every such pause); asks and
  answers are masked. Rules: `[name.not-kebab-case]`, `[channel-listener.duplicate-name]`,
  `[channel-listener.missing-handler]`, `[channel-listener.unknown-hook]`.
- **A model interpreter** (`@ChannelInterpreter({ prompt, model? })` on an empty class, a chat model) gets
  the target's answer tool, its `overrideInput` described by the approved tool's input with every
  field optional — "ok but only up to $500" is `{ approved: true, overrideInput: { amountUsd: 500 } }`,
  laid over the call's own arguments — and `answer-reply-interpreter-not-understood-dto` for a reply that does not
  answer ("🤷"), which is never a refusal (#648). Tests:
  `replyWith(ReplyInterpreterNotUnderstoodDto, { reason })`. For an approval (#688) its decision
  is named — `approve` / `approve-with-changes` / `refuse`; an unknown one, `approve-with-changes`
  without a correction, `approved` beside a decision or a correction that changes the call's shape
  (a new key at any depth, another kind of value, a list of another length) is not understood, and
  the corrected call passes the tool's own input strictly (an unknown key is refused). The kept
  record's `PauseAnswerRecord.asked` is the call as asked, beside its `decision`. Its model is the
  provider-cascade's (`modelProvider` on the interpreter, its workflow or the application) like any
  model; a decision model reads an approval only.
- **A reply interpreter may change approved arguments within the call's DTO; put money limits in a
  guardrail or the action.** A reply interpreter reads intent; it is not a guardrail (#688). It does not decide whether a
  correction is allowed — "never above the call's amount", "only in the call's currency", "never
  below 0". Put such a limit where it holds whoever approved the call: a tool interceptor's
  `beforeAnyTool` / `@BeforeTool` on the call as it runs (after the approval, with any correction —
  `ToolCallDecision.block(reason)` fails the step with `StepError.ToolBlocked`), or a check in the
  tool's or action's own code (`min` / `max` on the input DTO's field for a plain bound). The
  payment guarantees — `Idempotency.runOnce` and `sendOnce`, one charge per business key — hold whatever
  the interpreter reads.
- **Free text** that cannot be read throws `PauseError.UninterpretableReply` (`pause.uninterpretable-reply`,
  `reason`) and the pause stays `Pending`; a target without `channelInterpreter` →
  `PauseError.ChannelInterpreterMissing`. Exactly one of `decision` / a non-empty `reply`, else
  `ValidationError.DtoInvalid`.
- **A deadline for the answer** (#941): the target's `timeout` — `hours(24)`, at least
  `seconds(1)` — gives every pause of the target an absolute deadline, fixed when the pause is made (a
  deploy that changes `timeout` never moves an open pause; a profile's `toolApprovals` / `externalTasks`
  overlay changes it for the next ones); `resolveTimeout(ctx)` on the target class chooses one per pause
  (`[limits.timeout-invalid]` for a bad value). A different deadline for one step is a different
  target — there is no per-step override. A run's deadline bounds every pause too, the smaller wins and
  a tie goes to the run. `result.pending[].expiresAt` shows it.
  The deadline is **hard**: an answer at or after it is `PauseError.Closed` (`reason: expired`,
  `closedAt` the deadline), decided atomically in the store — an answer and the expiry racing: one
  wins. Within seconds the tree is taken and the target's optional
  `onExpired(ctx)` (`implements PauseExpiryHandler<Target>`, `ctx` = `ExpiredContext`: `input`, `expiresAt`,
  `trail`, …) says what the expiry means: `PauseExpiration.fail()` — the step fails with `StepError.PauseExpired`
  (`step.pause-expired`, `step`, `stepKind`, `target`, `kind`, `expiresAt`; `.onError(StepError.PauseExpired, …)`
  escalates; an agent's approval or task call fails the whole agent step, its spend kept) — or
  `PauseExpiration.decide(answer)` — the step goes on with that answer, validated like a resume's,
  recorded as answered by the framework (`PauseResolution.DecidedOnExpiry`, `ResumeReason.Expired`;
  `decide({ approved: true })` runs the tool with no person having looked: choose it knowing that) — or
  `PauseExpiration.reassign({ target?, channel?, assignees?, timeout?, reason? })` — the pause moves to
  another target in `escalatesTo` (or another channel or pool of the same target) with a new deadline, the
  tree rests paused (the escalation: "the manager did not answer, ask the director").
  Without the method the expiry is `fail()`. The handler runs once per expiry — again only after a
  crash before its decision was recorded — so it must only read; a throw, a hang past the tool's
  `timeout`, a value that is no expiration or an invalid answer fails the expiry with an
  `PauseError.ExpiryHandlerFailed` as the cause (`pause.expiry-handler-failed` warned, never the error's message).
  A pause the run's deadline bound fails the run with `LimitError.Deadline` and asks the channel
  nothing. `app.cancel` always beats an expiry (the pause is closed `expired`, the run cancelled).
  Over A2A the task goes `WORKING`, then `FAILED` (`step.pause-expired`) or `COMPLETED`; a follow-up
  before the look is `-32004 a2a.pause-closed` `reason: expired`.
- **A reminder and a changed deadline** (#942): `@ToolApproval({ timeout: hours(24), remindBefore: hours(2) })` —
  a positive finite duration shorter than the target's own `timeout` (`[pause.remind-before-invalid]`)
  — makes the channel's optional `onPauseExpiring(event)` (`ChannelPauseExpiringEvent`: `pauseId`,
  `input`, `expiresAt`, `deliveryId`) and a listener's optional `onPauseExpiring` (`ChannelListenerExpiringEvent`)
  hear "expiring at …" **once** per deadline, whatever the number of instances (the store's
  compare-and-set; no lease, nothing of the run moves). The reminder time is fixed when the pause is
  made: `expiresAt − remindBefore`, none when that is not after the ask; a `remindBefore` shorter than
  the pause timers' 5 s tick can be skipped by a tick that falls on none of its window
  (`[pause.remind-before-below-tick]`, a warning, an error under `--strict`); a pause bound by its run's
  deadline is reminded before that deadline; one with no deadline never. `await app.extendPause({ pauseId,
expiresIn: hours(24) }, { actor })` (the `ownerId` for an owner's pause — who may answer may change the
  deadline unless the target's `permitTimeoutChange(ctx)` says otherwise; the options are
  `PauseCallerOptions`: the caller fields only, no `signal` / `onStream` / `record`) moves an open pause's deadline to
  `now + expiresIn` and returns `PauseExtension` (`pauseKey`, `expiresAt`, `previousExpiresAt`); the
  channel's optional `onPauseTimeoutChanged(event)` (`ChannelPauseTimeoutChangedEvent`, + `previousExpiresAt`) and a
  listener's `onPauseTimeoutChanged` (`ChannelListenerTimeoutChangedEvent`) hear "moved to …", the reminder is
  made again before the new deadline. Refused: a closed pause or one past its deadline —
  `PauseError.Closed` (`reason: expired`) —, a pause with no deadline (none is ever added), a deadline
  not later than the current one, and one past the deadline of the run (or quorum) the pause was made
  under (exactly that deadline is allowed) — `ValidationError.DtoInvalid` (`dto: "ExtendPauseRequest"`);
  another tenant's pause is `PauseError.UnknownPause`; `escalationLimits` on the target bounds the number of
  extensions, reassignments and the total time (`PauseError.UpdateContended` when two race for one pause).
  An extension and the expiry look at one tick: the store lets one win.
- **Reassign a pause** (#946): `await app.reassignPause({ pauseId, assignees: ["deputy-3"] }, { actor })`
  (`ownerId` for an owner's pause; `PauseCallerOptions`, as `extendPause`; `ReassignPauseRequest` also takes a `target`
  from the target's `escalatesTo`, a `channel`, a `timeout` and a `reason`; `permitReassign(ctx)` on the target
  may refuse) moves an open pause to another addressee — the agent and the step do not run again — and
  returns `PauseReassignment` (`pauseKey` only: the new `pauseId` is a capability, given to the channel's
  `send` and to a `@ChannelListener({ includePauseIds })`, never to the caller or a log). The channel's `send`
  gets a new `ChannelAsk.pauseId`, `ChannelAsk.assignees` and `ChannelAsk.replaces` (`{ pauseId }`: the old
  message; both absent on a first send) and its `onPauseClosed` hears `reason: reassigned` for the old one
  (`PauseClosedReason.Reassigned`) — in no fixed order: edit the old message from `send`, or from the notice;
  `onPauseReassigned(event)` hears the move itself. The old id gives `PauseError.Closed` (`reassigned`); a closed
  pause or one past its deadline gives `PauseError.Closed`, an `assignee` that is no key's text `ValidationError.DtoInvalid`
  (`dto: "ReassignPauseRequest"`); two reassignments, or a reassignment and an answer, at once: exactly one wins.
  A new `send` that fails or never happens (the instance died) is made up by another instance's pause timers within a minute
  (at-least-once: deduplicate by the new `pauseId`). A new `send` that returns `ChannelOutcome.decided(…)` answers the replacement at once, once.
  `assign(ctx)` on the target picks the assignees of a new pause; `permitAnswer(ctx)` says whether an
  answer is taken (a refusal is `PauseError.PermissionDenied`). A hook the framework does not enforce for
  a target is `[pause.permit-hook-not-enforced]`.
- **Deadlines in working time** (#944): `timeout`, `remindBefore` and `extendPause`'s `expiresIn` take
  `workHours(n)` / `workMin(n)` / `workDays(n)` (`@agboss/core/units`) beside `hours(n)` — counted by the
  target's `calendar` (a `@WorkingCalendar` class; there is no application-wide calendar). `WorkingWeek.of({ timeZone,
days: [Weekday.Sunday, …], hours: [{ from: "09:00", to: "18:00" }], breaks?, holidays? })` is the built-in
  grid (DST-safe: working time is the real elapsed time of the instants whose local time is in `hours` and in no
  `break`; `"24:00"` ends the date; no overnight interval — write two); a `@WorkingCalendar({ name:
"holidays", deps })` class listed in `providers` implements `resolveSchedule({ from, amount, tenantId, target,
assignees })` (returns a `WorkingWeek.of(…)` or `WorkingWeek.anyOf([…])`, the core does the DST arithmetic) or
  `addWorkingTime(…)` itself, and may read the application's own data; `@WorkingCalendar({ week })` on an empty
  class declares a grid. `workDays(n)` counts working days of the schedule (a date with working time; weekends
  and holidays skipped), not 24 hours; `isHoliday(localDate)` is a holiday rule beside `holidays`. The deadline is computed **once**, when the pause opens
  (before the channel is asked), into `expiresAt` / `remindAt`; a calendar changed later never moves an open
  pause — change its deadline. Reminder: both working → `calendar.add(askedAt, timeout − remindBefore)`; a working
  `remindBefore` needs a working `timeout` (`[pause.remind-before-working-without-working-timeout]`; `extendPause`
  refuses a plain `expiresIn` there with `ValidationError.DtoInvalid`). A working duration with no `calendar` on the target is
  `[calendar.required-for-working-duration]`. A calendar that throws, times out,
  answers no `Date` or a date not after `from` fails the step — `StepError.ExternalTask` / `StepError.Agent` with
  a `PauseError.WorkingCalendar` (`pause.working-calendar`) as its `cause` — and nobody is asked; an extension with
  it rejects with it. The run's deadline stays wall-clock (the smaller wins, a tie to the run).
- **Expiry in parallel launches (#945):** a branch whose pause expired ends `BranchStatus.Expired`
  (its error `step.pause-expired` stays in `result.launches`). A pause asked in a quorum branch is
  bound by the quorum's deadline (`PauseExpiryBound.Quorum`): at it the tree wakes by itself and the
  quorum decides — an expired branch did not vote, never fails the launch, whatever its
  its `skip()`; `StepError.QuorumNotReached.expired` lists the node ids that expired. In a plain
  `.join()` an expired branch follows its `.onError(E, skip())`: a skipped one is dropped, else it fails the
  launch with its `StepError.PauseExpired` for `.onError(…)`, and the branches still waiting are
  withdrawn. The side path of `.onError(…)` reads the answers already settled as `optional(XDto)`
  inputs of its first step (a per-item list stays a list); each branch that had answered hears
  `onPauseJoinFailed(event)` (`ChannelPauseJoinFailedEvent`: `launch`, `errorCode`, `at`) on its channel
  and on listeners (`ChannelListenerJoinFailedEvent`), once per pause, "the parallel step this answer
  belongs to did not collect all its answers; its error path is running".
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
import { SlackRefundChannel } from "./src/refunds/channels/slack-refund.channel.js";
import { RefundTool } from "./src/refunds/tools/refund.tool.js";
-->

```ts
const test = testWith(RefundsApplication);

test("a large refund waits for the manager, then runs", async ({ app, mockModel, mockService }) => {
  mockService(SlackRefundChannel).send.mockResolvedValue(ChannelOutcome.awaitReply());
  mockModel(RefundAgent).thenReturn(
    callTool(RefundTool, { orderId: "7", amountCents: 90_000 }),
    replyWith("Refunded order 7."),
  );

  const paused = await app.execute(RefundWorkflowStart, { text: "refund order 7" });
  expect(paused.pending).toHaveLength(1);
  const [ask] = mockService(SlackRefundChannel).send.mock.calls[0] ?? [];

  const done = await app.resume(
    { pauseId: ask?.pauseId ?? "", decision: { approved: true } },
    { actor: { id: "manager-17" } },
  );
  expect(done).toFinishWith(RefundWorkflowFinish, { text: "Refunded order 7." });
});
```

- `mockService(Channel).send.mockResolvedValue(ChannelOutcome.decided({ approved: true }))` decides
  at once; `testWith(App, { channels: [AutoApproveChannel.for(RefundToolApproval)] })`
  replaces the target's channel for the whole test (`AutoRejectChannel.for(…)` refuses).
- The fixtures `answerPause(Target, decision)` and `replyToPause(Target, "text")` answer a pause of
  a target in an eval or a test script; `listPauses({ target })` reads what waits.
- A model reply interpreter is scripted by its input: `mockModel(Interpreter).when({ reply: "ok" })
.thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true }))`; one on a decision model
  with `decideWith({ approved: 0.9 })`.

## Rule codes and errors

| Code / error                                                                                                 | Cause → fix                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[channel.wrong-tool]`                                                                                       | the approval's `input` is not the tool's `input`, or a tool names an external task → make them the same DTO; ask a task with `.toExternalTask(Task)`                      |
| `[channel.missing-for-target]`                                                                               | a target with a delegate (or an owner's with `Delegate` users) and no `@Channel({ target })` in `@Application({ channels })` → list one                                   |
| `[channel.ambiguous-for-target]`                                                                             | several channels of one target and no `@ChannelSelector` → add one, or list one channel                                                                                   |
| `[channel.target-invalid]`                                                                                   | `@Channel({ target })` names a class that is no `@ToolApproval` / `@ExternalTask` → name a target                                                                         |
| `[channel.ttl-invalid]`                                                                                      | a channel's `ttl` is no finite duration over the 30 s lease → `days(14)`                                                                                                  |
| `[channel-selector.no-select-method]`, `[channel-selector.target-invalid]`                                   | a `@ChannelSelector` without `selectChannel(ctx)`, or naming a class that is no target → fix it                                                                           |
| `[channel-interpreter.not-an-interpreter]`                                                                   | `channelInterpreter:` names an undecorated class → decorate it `@ChannelInterpreter({ … })`                                                                               |
| `[channel-interpreter.no-interpret-method]`                                                                  | a code interpreter without `interpret` → add it                                                                                                                           |
| `[channel.shared-interpreter]`                                                                               | one `@ChannelInterpreter` on two targets → one each                                                                                                                       |
| `[reply-interpreter.decision-model]`                                                                         | an external task's interpreter on a decision model → a chat model, or a code interpreter                                                                                  |
| `[channel-listener.missing-handler]`, `[channel-listener.unknown-hook]`, `[channel-listener.duplicate-name]` | a `@ChannelListener` with no hook, a hook it does not know, or one name twice → fix it                                                                                    |
| `StepError.ExternalTask`                                                                                     | a task's `send` threw or `decided(…)` was not the output DTO (`step.external-task`, `question`) → `.onError`                                                              |
| `StepError.PauseExpired`                                                                                     | a pause's deadline passed with no answer (`step.pause-expired`) → `.onError(StepError.PauseExpired, …)`, or `onExpired` → `PauseExpiration.decide(…)` / `.reassign(…)`    |
| `[limits.timeout-invalid]`                                                                                   | a target's `timeout` under `seconds(1)`, over 5 years or no finite duration → `hours(4)`                                                                                  |
| `[pause.remind-before-invalid]`                                                                              | `remindBefore` is not a positive duration shorter than the `timeout` → `hours(2)` under `hours(24)`                                                                       |
| `[pause.remind-before-below-tick]`                                                                           | `remindBefore` is shorter than the pause timers' 5 s tick (a warning): the reminder can be skipped → at least 5 s                                                         |
| `[pause.remind-before-working-without-working-timeout]`                                                      | a working `remindBefore` over a plain `timeout` → give `timeout` in `workHours`, or `remindBefore` in plain time                                                          |
| `[pause.incompatible-escalation-target]`                                                                     | `escalatesTo` names a class of another kind, or one that takes other DTOs → a target of the same kind and DTOs                                                            |
| `[pause.permit-hook-not-enforced]`                                                                           | a `permit…` hook on a target that cannot enforce it → drop it                                                                                                             |
| `[working-calendar.invalid]`                                                                                 | a grid with an unknown zone, no days, a bad interval, a break outside the hours, no working minute; a class that is no listed `@WorkingCalendar` → fix it                 |
| `[working-calendar.duplicate-name]`                                                                          | two listed `@WorkingCalendar` classes with one `name` → give each its own                                                                                                 |
| `PauseError.WorkingCalendar`                                                                                 | a pause's calendar failed (`pause.working-calendar`, `calendar-failed` \| `calendar-timeout` \| `not-a-date` \| `not-after-start`) → the step's `cause`; nobody was asked |
| `[di.ambiguous-implementation]`                                                                              | two implementations of one service → keep one (one per application)                                                                                                       |
| `[di.infrastructure-in-workflow]`                                                                            | a channel or a provider in `@Workflow({ providers })` → `@Application({ channels })` / `({ providers })`                                                                  |
| `[application.in-memory-pauses]`                                                                             | pauses possible on the in-memory stores (a warning; an error under `--strict`) → a durable `@DatabaseStorage`                                                             |
| `PauseError.PermissionDenied`                                                                                | `ownerId` for a Delegate target or `actor` for an Owner target → the other credential                                                                                     |
| `ExecutionError.IncompatibleResume`                                                                          | resumed on an app with another config hash → `WorkflowSettings.builder().onIncompatibleResume(…)`                                                                         |

## Pitfalls

- Naming the channel on the tool (`approval: SlackRefundChannel`): name the target.
- Reading the `pauseId` from `result.pending` for a `Delegate` target — it is not there by design; the
  channel gets it in `ask.pauseId` and is its reply key.
- A channel that sleeps until an answer: return `awaitReply()` and let `app.resume` continue it.
- Pauses on the in-memory stores in production: they vanish on restart.
- A per-step deadline: there is none; make a second target with the other `timeout`.
