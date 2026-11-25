# Pauses

A pause waits under a **pause target** (#1307): a tool that needs a decision names its
`@ToolApproval` ([Tools → Approval channels](Tools#approval-channels)), and a workflow that needs a
person's typed answer asks an `@ExternalTask` from a flow step
([below](#a-question-the-workflow-asks-toexternaltasktask-659), #659). The target says what is asked, who may
answer (`respondent`) and for how long (`timeout`); the **channel** — a `@Channel({ target })` class — is only
the transport that tells the people. When the channel answers `ChannelOutcome.awaitReply()` — or an `Owner`
target has no channel — the call or the step **pauses** until someone answers it.
An execution may wait for **several answers at once** — parallel branches each pause on their own —
and each pause is answered **by its id** (#267). How a pause maps onto LangGraph and the agent's
loop: [Pause seam](Pause-seam).

> A runnable example: `examples/flow-patterns/src/approvals/` — two approvals at once, answered in
> the terminal ([Example](Example#flow-patterns-a-review-loop-and-a-code-router), #346).
>
> A committee of `@ExternalTask`s in `.inParallel([…])`, one pause each, counted by an arbiter:
> `examples/flow-patterns/src/committee/` ([Parallel → External tasks in a launch](Parallel#external-tasks-in-a-launch-1306), #1306).

## A pause stops only those who cannot go on without it

A paused branch of a [parallel launch](Parallel) does not stop its siblings: they run to their end
in the same pass (a paused branch frees its `maxConcurrency` slot), and the execution rests only
when nothing else can move — the join waits only for the paused ones. `result.pending` lists every
waiting pause, one `PendingPause` each:

| Field              | What it is                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- |
| `kind`             | `PauseKind.Approval` (a tool call) or `PauseKind.ExternalTask` (an external task's step, #659) |
| `pauseId`          | what `app.resume` takes — only for a `PauseRespondent.Owner` pause (below)         |
| `respondent`       | who may answer it: `PauseRespondent.Owner` or `PauseRespondent.Delegate` (its target's); who answered is `actor` (a `PauseActor`, #1307) |
| `step`, `target`, `channel` | the step that asks — the agent whose tool call waits, or the external task's step —, the pause target it waits under, and the channel asked (absent for an owner's target with none) |
| `itemIndex`        | the item of a per-item launch it waits in — no copy of the item                        |
| `childExecutionId` | the child execution it waits in ([Workflow as a step](Workflow-as-a-step#at-run-time)); `undefined` in the root |
| `input`            | what it asks: an approval's tool arguments, or an external task's input, as `Readonly<Record<string, unknown>>`; `sensitive` fields masked |
| `toolCall`         | an approval only: the call it waits on, `{ callId, tool, summary? }` |
| `assignees`, `externalRef` | who it is for (a 1-of-N pool), and the id its channel's system gave it (a ticket key) |
| `trail`            | its chain of custody, newest last: `opened`, then one entry per reassignment (who, when, to whom, why) |

The fields every kind has are `PendingPauseBase`; `PendingPause` is `PendingApproval |
PendingQuestion`, told apart by `kind`. Narrow on `kind` before reading `toolCall`: only an approval has one;
`input` is on every pause —

```ts
import { PauseKind, type PendingPause } from "@agboss/core";

export function describePause(pause: PendingPause): string {
  if (pause.kind === PauseKind.Approval) return `${pause.step} calls ${pause.toolCall.tool}`; // typed
  const fields: Readonly<Record<string, unknown>> = pause.input; // the arguments or the task's input, masked
  return `${pause.step} asks ${JSON.stringify(fields)}`;
}
```

A pause inside a child workflow is its root's: it is listed in the root's `pending` (with the
child's `childExecutionId`, and for a per-item child its `itemIndex`), several children may wait at
once, and `app.resume({ pauseId, decision })` answers it like any other — the child goes on with the
id it paused with, then its parent.

`status` is `ExecutionStatus.Paused` while `pending` is not empty; a finished execution has
`pending: []`. `onExecutionPause` (`event.pending`) fires each time the execution rests because
nothing else can move — again after a partial resume when others remain; a branch re-entering its
own waiting pause fires nothing.

## Answering a pause: `app.resume({ pauseId, decision }, options)`

<!-- snippet-context
import type { App } from "@agboss/core";
declare const app: App;
declare const replyKey: string;
-->

```ts
// a Slack webhook: the finance manager pressed "Approve"; the message's reply key is the pauseId
const result = await app.resume(
  { pauseId: replyKey, decision: { approved: true } },
  { tenantId: "acme", actor: { id: "manager-17" } },
);
console.log(result.threadId, result.executionId, result.pending.length);
```

- **By its id, always** — one way, also when there is only one pause, and without a `threadId`: the
  pause is found by `(tenantId, pauseId)` anywhere in the execution tree (a parallel branch, a child
  at any depth) and the runtime wakes the chain up to the root. An unknown id, or another tenant's,
  is the same `PauseError.UnknownPause` (`pause.unknown-pause`), with no hint that the id exists elsewhere.
- **The rest keep waiting**: with other pauses left the execution pauses again with them
  (`status: Paused`, the rest in `pending`); the last answer lets it go on to its finish. The result
  carries `threadId` and `executionId`, so a webhook that needs them gets them back.
- **The decision is validated before it is recorded**: a `ToolCallApprovalDecisionDto` —
  `approved`, `reason?`, `overrideInput?` (only with `approved: true`, and a valid input of the
  tool) — else `ValidationError.DtoInvalid` and the pause keeps waiting. The same check applies to a
  channel's `ChannelOutcome.decided(…)` (the step fails). Approved → the tool runs once (with the
  `overrideInput`, if given); rejected → the model reads `Tool error: the call was rejected by
  <who answered>[: <reason>]`.
- `app.cancel(threadId)` stays by thread — a conversation is cancelled, not a pause: its pauses are
  withdrawn.

## Answering with free text: `app.resume({ pauseId, reply }, options)`

A webhook that only has the person's words — a Slack thread reply, a mail — passes them as they
are; the pause's target reads them with its **reply interpreter** (#267 PR 3), named on the target:

<!-- snippet-context
import { inline, PauseRespondent, ChannelInterpreter, type App, ExternalTask, ToolApproval } from "@agboss/core";
import { Integer, Text } from "@agboss/core/dto";
import { hours } from "@agboss/core/units";
declare const app: App;
declare const replyKey: string;
export class RefundCardInputDto {
  @Text() orderId!: string;
  @Integer() amountCents!: number;
}
-->

```ts
@ChannelInterpreter({
  name: "refund-reply-interpreter",
  description: "Turns a manager's free-text reply into a refund decision",
  model: "moonshotai/kimi-k2.6",
  prompt:
    inline("The manager answered a refund approval in free text. Decide approve / reject and any changed amount."),
})
export class RefundReplyInterpreter {}

@ToolApproval({
  name: "refund-tool-approval",
  description: "Approves card refunds",
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
  channelInterpreter: RefundReplyInterpreter,
})
export class RefundToolApproval {}

// the webhook passes the text as it came; the result is the same as with a decision
await app.resume({ pauseId: replyKey, reply: "ok, but only half" }, { tenantId: "acme", actor: { id: "manager-17" } });
```

- **Exactly one of `decision` or `reply`** — by types (`ResumeRequest = DecisionResumeRequest |
  ReplyResumeRequest`) and at run time: both, or an empty `reply`, is `ValidationError.DtoInvalid` before the
  pause is looked up. The credential (`ownerId` / `actor`) is checked as for a decision.
- **The interpreter gets the pause's original question and the reply** — `{ ask, reply }`, where the
  amount to halve is in `ask.arguments` — and what it gives is validated like a decision (the target's
  answer DTO: `ToolCallApprovalDecisionDto` for an `approves` role, `overrideInput` checked by
  the tool's input). Code downstream decides by types, never by the text.
- **`DecidedBy.Model`** — a chat model answers through one answer tool of the target's answer DTO; its
  static `prompt` are its instructions, the question and the reply come in the input
  message (`### ask` / `### reply`, #270 Q51). For a tool approval (#648) the answer tool describes
  `overrideInput` by the approved tool's input, every field optional: the fields the reply
  changes, laid over the call's own arguments (`ask.arguments`) before validation — "ok but only up
  to $500" is `{ approved: true, overrideInput: { amountUsd: 500 } }`. Beside it the model has
  `answer-reply-interpreter-not-understood-dto` (`ReplyInterpreterNotUnderstoodDto { reason }`,
  `@agboss/core/dto`) for a reply that does not answer ("🤷", off topic): never a refusal — the pause
  stays `Pending`, `PauseError.UninterpretableReply.reason` is "the reply does not answer the question:
  <its reason>", as a code interpreter's `notUnderstood`. One call per move (`parallel_tool_calls:
  false`); a "not understood" call wins over an answer beside it. The framework's instructions
  and tools (#688) make a one-line `prompt` enough on a cheap model: for a tool approval the
  answer tool names three decisions — `approve` (the call as it is: a plain yes, or a limit at or
  above the call's value; a correction beside it is dropped), `approve-with-changes` (with
  `overrideInput`: "yes, up to $900", "ok but max 900", "да, но не больше 900 долларов", "כן, עד
  900 דולר" on a $1,200 call → 900) and `refuse` (a no, with or without a reason) — mapped onto
  `ToolCallApprovalDecisionDto` (a scripted answer in the DTO's own shape is read as it is); no yes
  or no, a maybe, a question back is not understood. The model's answer is checked for its shape,
  failing closed: the tool's schema is strict, an unknown decision or `approve-with-changes` without
  a correction is not understood, an `approved` beside a decision is no answer (the decision alone
  sets it), a correction keeps the call's shape — no new key at any depth, no other kind of value,
  no list of another length; nested objects are laid over the call's —, and every decision's
  `overrideInput` pass the tool's own input strictly (an unknown key at any depth is refused,
  never dropped). The kept record keeps the call as asked (`asked`) beside the decision. Tests:
  `mockModel(I).thenReturn(replyWith(ReplyInterpreterNotUnderstoodDto, { reason }))`. **For a tool approval the model may be a decision
  model** (Jev, #267 S124 a): it reads approve / refuse only — one `Decision.boolean("approved")` about
  the question and the reply (the same input message, as the decision's state), the interpreter's
  `prompt` after the framework's question as its instructions; approved when P(yes) > 0.5, the
  answer `{ approved }` — never a `reason` or `overrideInput`; an external task's interpreter
  on a decision model is `[reply-interpreter.decision-model]` (#659: its answer needs more than a
  yes / no). For an external task the model's answer tool is the target's `answer` DTO's, the system
  message asks for the fields the reply gives, and nothing is laid over a call. Either
  model's call goes through the provider its model
  resolves to by `serves` (`[model.unserved]` like any model), is checked against the tree's budgets
  before it is made (an exhausted one → `BudgetExceededError`, the pause untouched), is counted in
  their ledger at once and in the execution's `spend` when the step takes the answer — once — and is
  traced under the pause's execution (cost caller `reply-interpreter:<name>`). Its model reads the
  question and the reply through the application's and the workflow's PII policies (#120), like an
  agent's: a `tokenize()` value is a token for the model, its answer is revealed before it is
  validated (the tool gets the real value), a token no map knows is a decline (the pause stays
  `Pending`), a `block` value in them throws `PiiRefusedError`.
- **`DecidedBy.Code`** — `implements ReplyInterpreterHandler<Self>`: `interpret(input:
  InputOf<Self>)` returns its outcome (#267 S124 b), sync or as a promise —
  `ChannelInterpretation.understood(decision)` (`OutputOf<Self>`, validated like any decision) or
  `ChannelInterpretation.notUnderstood({ reason })` for a reply it cannot read; a plain object does not
  compile (the pattern of `ChannelOutcome` and `JudgeVerdict`). Typed by the generated
  `.agboss/types.d.ts`; `deps` like any component, created by the application's container. A `throw`
  is for an unexpected crash only: it is unreadable too, the thrown error its `cause`.
- **Either kind reads in the pause's execution frame**: an injected `ExecutionContext` reads the
  pause's execution — its `tenant`, `ownerId`, the execution's own fields — and the waiting step
  (`step.nodeId`, `step.callId`, its idempotency key), so the provider's rate limits see the tenant.
- **The pause survives a bad reply**: interpretation runs before the pause is closed. A reply that
  cannot be read as a valid answer — a code interpreter's `notUnderstood`, a model that gave no
  answer, an answer invalid for the target, an interpreter that crashed — throws
  `PauseError.UninterpretableReply` (`pause.uninterpretable-reply`; `reason` — the interpreter's own, or
  the error's message — and `cause` when an error is behind it), and the pause stays `Pending`: ask
  for a clearer answer, or answer with a `decision`. A `reply` for a target without `channelInterpreter` is
  `PauseError.ChannelInterpreterMissing` (`pause.channel-interpreter-missing`), the pause untouched.
- Assembly checks, all at once with the channel rules: `[name.not-kebab-case]`,
  `[reply-interpreter.not-an-interpreter]` (a `channelInterpreter` class without `@ChannelInterpreter`),
  `[reply-interpreter.no-interpret-method]`, `[channel.shared-interpreter]` (one class in two roles).

Both new forms side by side — a decision model for a deposit return, and an owner's buttons read by
code:

<!-- snippet-context
import { inline, Agent, Channel, ChannelOutcome, DecidedBy, Injectable, PauseRespondent, ChannelInterpretation, ChannelInterpreter, Tool, Workflow, WorkflowFinish, WorkflowStart, onStart, type ChannelAsk, type InputOf, type OutputOf, type ChannelInterpreterHandler, ExternalTask, ToolApproval, Ttl } from "@agboss/core";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
import { hours } from "@agboss/core/units";
import { DecisionsDriver, ModelProvider } from "@agboss/core/models";
import { secret } from "@agboss/core";
import { seconds } from "@agboss/core/units";
@ModelProvider({ driver: DecisionsDriver({ apiKey: secret("OPENROUTER_API_KEY"), baseUrl: "https://openrouter.ai/api/v1" }), timeout: seconds(30) })
export class DecisionsModelProvider {}

export class DepositReturnDto {
  @Text({ prompt: "the lease whose deposit is returned" })
  leaseId!: string;
}
export class ExpenseDto {
  @Text({ prompt: "what the expense is for" })
  purpose!: string;
}
export class DeskDoneDto {
  @Text()
  status!: string;
}
-->

```ts
// approve / refuse on a decision model: one Decision.boolean("approved"), no reason, no overrideInput
@ChannelInterpreter({
  name: "deposit-reply-interpreter",
  description: "Reads whether a clerk's reply approves a deposit return",
  model: "typesafe/jev-1.13",
  modelProvider: DecisionsModelProvider, // a decision model: a provider with a DecisionsDriver
  prompt: inline("The clerk answered a deposit return."),
})
export class DepositReplyInterpreter {}

@ToolApproval({
  name: "deposit-tool-approval",
  description: "A clerk approves deposit returns",
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
  channelInterpreter: DepositReplyInterpreter,
})
export class DepositToolApproval {}

// by code: the chat app sends a button's value back — {"approved":true}; anything else is not understood
@ChannelInterpreter({
  name: "expense-reply-interpreter",
  description: "Reads an expense button's value",
})
export class ExpenseReplyInterpreter implements ChannelInterpreterHandler<ExpenseReplyInterpreter> {
  interpret(
    input: InputOf<ExpenseReplyInterpreter>,
  ): ChannelInterpretation<OutputOf<ExpenseReplyInterpreter>> {
    const value: unknown = JSON.parse(input.reply); // a text that is no JSON: a crash
    if (typeof value !== "object" || value === null || !("approved" in value))
      return ChannelInterpretation.notUnderstood(`not an expense button: ${input.reply}`);
    return ChannelInterpretation.understood({ approved: value.approved === true });
  }
}

@ToolApproval({
  name: "expense-tool-approval",
  description: "The thread's owner confirms an expense with two buttons",
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
  channelInterpreter: ExpenseReplyInterpreter,
})
export class ExpenseToolApproval {}

@Channel({ name: "desk-deposit-approval-channel", description: "Asks the clerk on duty", target: DepositToolApproval, ttl: hours(1) })
export class DeskDepositApprovalChannel {
  send(_ask: ChannelAsk<DepositToolApproval>): Promise<ChannelOutcome<DepositToolApproval>> {
    return Promise.resolve(ChannelOutcome.awaitReply()); // posts the question, keyed by pauseId
  }
}

@Channel({ name: "button-expense-approval-channel", description: "Shows the owner two buttons",
  target: ExpenseToolApproval, ttl: hours(1),
})
export class ButtonExpenseApprovalChannel {
  send(_ask: ChannelAsk<ExpenseToolApproval>): Promise<ChannelOutcome<ExpenseToolApproval>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "return-deposit-tool",
  description: "Returns a deposit",
  input: DepositReturnDto,
  output: DeskDoneDto,
  approval: DepositToolApproval,
})
export class ReturnDepositTool {
  execute({ leaseId }: DepositReturnDto): Promise<DeskDoneDto> {
    return Promise.resolve({ status: `returned the deposit of ${leaseId}` });
  }
}

@Tool({
  name: "book-expense-tool",
  description: "Books an expense",
  input: ExpenseDto,
  output: DeskDoneDto,
  approval: ExpenseToolApproval,
})
export class BookExpenseTool {
  execute({ purpose }: ExpenseDto): Promise<DeskDoneDto> {
    return Promise.resolve({ status: `booked ${purpose}` });
  }
}

@Agent({
  name: "office-agent",
  description: "Returns deposits and books expenses",
  prompt: inline("Do what is asked."),
  model: "moonshotai/kimi-k2.6",
  tools: [ReturnDepositTool, BookExpenseTool],
})
export class OfficeAgent {}

@WorkflowStart({ name: "office-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class OfficeWorkflowStart {}

@WorkflowFinish({ name: "office-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class OfficeWorkflowFinish {}

@Workflow({
  name: "office-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OfficeWorkflowStart)
      .toAgent(OfficeAgent)
      .toFinish(OfficeWorkflowFinish),
  ],
})
export class OfficeWorkflow {}
```

### A reply interpreter reads intent — it is not a guardrail

**A reply interpreter may change approved arguments within the call's DTO; put money limits in a
guardrail or the action.**

A reply interpreter turns a person's words into a decision on the call: approve, approve with a
change, refuse, or not understood. It does not judge whether that decision is allowed. "Never above
the amount the agent asked", "only in the call's currency", "never below 0" are rules of the call,
and they hold only where every approval passes — whoever or whatever approved it, a button, a
script, a model reading free text. Put them there: a tool interceptor's `@BeforeTool` / `beforeAnyTool` sees the
call as it runs, after the approval and with any correction laid over it, and
`ToolCallDecision.block(reason)` fails the step with `ToolBlockedError` before the tool runs; or
the tool's (or action's) own check, and `min` / `max` on the input DTO's field for a plain bound,
which the corrected call is validated against. This is deliberate, not a gap the framework leaves to fill later: "a raise",
"another currency" or "too much" is a rule of the business, and only a check every approval passes
holds it — one inside the interpreter would hold for free text and miss a button, a script or a
channel's `decided(…)`. A raise a reply made is auditable: the execution record's pause keeps the
call as asked (`asked`) beside the call as it ran (`decision`).

<!-- snippet-context
import { ToolCallDecision, ToolInterceptor, type ToolCallContext } from "@agboss/core";
-->
```ts
@ToolInterceptor({
  name: "payout-limit-tool-interceptor",
  description: "Blocks a payout above the treasury's limit, whoever approved it",
})
export class PayoutLimitToolInterceptor {
  beforeAnyTool({ input }: ToolCallContext): ToolCallDecision {
    const amount =
      typeof input === "object" && input !== null && "amountCents" in input ? input.amountCents : 0;
    return typeof amount === "number" && amount > 150_000
      ? ToolCallDecision.block("a payout above $1,500")
      : ToolCallDecision.allow();
  }
}
// @Tool({ …, toolInterceptors: [PayoutLimitToolInterceptor] }) on the payout tool
```

The payment guarantees do not depend on the interpreter: an idempotent write still runs once per step,
an outbound call is still sent once per key and recovered, one business key is still charged once
([Payments](Payments), [Guarantees](Guarantees)) — whatever the interpreter read.

## A question the workflow asks: `.toExternalTask(Task)` (#659)

An **external task** — `@ExternalTask({ name: "…-external-task", description, input: AskDto, output:
AnswerDto, respondent, timeout, channelInterpreter?, maxVisits? })` on an empty class — is asked by a
flow step: `.toExternalTask(Task)` (or `onExternalTask(Task)…` for its own
path, a question asked again on a cycle; `maxVisits` its limit there). The task is the step's node
(`NodeKind.Question`; its name ends with `-external-task`, `[name.kind-suffix]`); the step reads one
`AskDto` from the path (`[input.missing-on-path]` when none comes), asks its channel —
`send({ pauseId, input })`, the `sensitive` fields masked — and gives the answer as its
value for the steps after it. The channel is a `@Channel({ target: Task })` class; an `Owner` task with none
waits for `app.resume` (channel-less). Everything else is a pause like an approval's:

- `ChannelOutcome.awaitReply()` pauses: `result.pending` lists it with `kind: PauseKind.ExternalTask`,
  `step` the question step, `input` the masked question; `ChannelOutcome.decided(answer)` goes on at once
  (`PauseResolution.Decided`).
- `app.resume({ pauseId, decision })` — the decision validated as `AnswerDto` before anything is
  recorded (`ValidationError.DtoInvalid`, the pause still pending); `{ pauseId, reply }` — read by the target's
  interpreter into `AnswerDto` (not understood → `PauseError.UninterpretableReply`, still pending; no
  interpreter → `PauseError.ChannelInterpreterMissing`). Who may answer is the target's `respondent`, checked as above.
- Exactly one answer wins (`PauseError.Closed` for the second, at the same time too); another instance
  continues it from the checkpoint and the channel is not asked again; `app.cancel` withdraws it
  (its channel's `onPauseClosed` told); `retention.pauseRecords` and `result.record.pauses` as for any
  pause — the record's `kind` is `PauseKind.ExternalTask` (stored, never inferred), its step the
  question's (`component.kind: "external-task"`, no `callId`).
- The step is code, no model: no step slot, not one of `maxSteps`; the execution's budgets are
  checked before it asks (a question when the money is gone asks nobody), its holder's fence right
  before `send` (a holder past its lease asks nothing). A `send` that throws, or a `decided(…)` that
  is not an `AnswerDto`, is `QuestionFailedError` (`step.question`, a `StepFailedError`; `question`
  the step, also in `details`) — `.onError(E, …)` right after `.toExternalTask(Task)` takes it.
- **As an `.onError` side-path start (#933):** `.onError(E, toExternalTask(Task)…)` — an
  external task's step handles the failure (the escalation "the manager did not answer, ask the
  director"); it reads its `ask` from the path as it stood before the failed step, and its answer goes
  on the path. One task is one node: its `maxVisits` counts the main path and the side path together.
  A side path that can catch a limit (`LimitExceededError`, `BudgetExceededError`, `AGBossError`, …)
  still leads only to actions and finishes: a question there is `[graph.limit-handler-uses-model]`
  (a reply interpreter may call a model).
- The generated tables type the task as `{ input: AskDto; output: AnswerDto }`, so the channel's
  `ask.input` and `decided(…)` are typed; the interpreter's `InputOf` is `{ ask: AskDto; reply }`,
  its `OutputOf` `AnswerDto`. The step's own `InputOf<Role>` is `{ ask: … }` (#802), the target's
  `ask` read from the path. `agboss describe` prints the task with `asked at <step> (<workflow>)`.
- A tool that names an external task as its `approval` is `[channel.wrong-tool]` — an agent asks one by listing the
  task itself in its tools ([below](#an-agent-asks-an-external-task-as-a-tool-712)).

## An agent asks an external task as a tool (#712)

When the model should decide **whether** and **when** to ask, the target goes in the agent's tools —
`@Agent({ …, tools: [SpendingLimitExternalTask, OrderTool] })`. The model sees a tool named the target's
name (`spending-limit-question`), described by the target's description, its input the target's `ask`;
it calls it like any tool, and:

- Its arguments are validated as the target's `ask` first, strictly (a field the ask does not declare
  is refused too): invalid ones ask nobody — no pause, no send —, the model reads a tool error and
  may try again, and the call counts against the target's `maxVisits`. Only the validated ask reaches
  the channel.

- The call is asked at the loop's approval step, before the move's other tools run — one pause per
  call, keyed by the call's step key, the calls of one move one after another (as approvals are).
  Nothing runs before the ask, so the loop's re-entry on resume repeats nothing and the channel is
  never asked twice.
- `result.pending[i]`: `kind: PauseKind.ExternalTask`, `step` the asking agent, `channel` the target,
  `ask` the masked question; the record's `kind` is `PauseKind.ExternalTask` and its `component` the
  role (`kind: "question"`).
- The answer — a `decision` validated as the target's `answer` DTO, a reply its interpreter read into
  it, or the channel's `decided(answer)` — is the **call's result**: it goes through the tool-result
  path (the answer DTO's `sensitive` fields masked for the model, `maxResultSize`, `onToolStart` /
  `onToolEnd` once, after the answer, `result.toolCalls` with `step.component.kind` `question`, its
  `output` the answer). Tool interceptors do not apply: the call runs no tool.
- Every guarantee of a question step holds: one answer wins, another instance resumes it, a cancel
  withdraws it, tenant and owner checks, an interpreter that does not understand keeps it pending.
- The target's `maxVisits` bounds how many of its calls one visit of the agent asks: the next one fails
  the step with `VisitsLimitExceededError` before it is asked. The budgets and the holder's fence
  are checked before every ask (a budget another execution exhausted meanwhile asks nobody).
- A `send` that throws, or a `decided(…)` that is not an `AnswerDto`, fails the agent's step
  (`AgentFailedError`, the cause kept). A tool approval in `tools` is
  `[channel.approval-role-as-tool]`. An agent loop with no pause seam reads a tool error.
- Tests: `callTool(SpendingLimitExternalTask, { item, priceUsd })`, typed by the target's ask;
  `agboss describe` prints `asked at <agent>'s tool loop (<workflow>)`.

## Who may answer

`@ToolApproval({ …, respondent })` and `@ExternalTask({ …, respondent })` require it (no default): a forgotten value must not let a customer
approve their own refund. One meaning per name (#934): **`respondent` is who *may* answer**
(`PauseRespondent`), **`actor` is who *did*** — the person, a string, in `app.resume`'s options, on a
pause's answer and in the audit trail. A target names its `respondent`; 0.1.0's `PauseAnswerer.ThreadOwner` / `.Channel`
are `PauseRespondent.Owner` / `.Delegate` (#1307).

| `respondent`                   | `resume` takes                                    | Its `pauseId`                                       |
| ---------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `PauseRespondent.Owner`  | the thread's `ownerId` (another → `ExecutionError.ThreadOwnerMismatch`) | listed in `result.pending`                      |
| `PauseRespondent.Delegate`      | `actor: { id: "manager-17" }` — non-empty            | only in the channel's `ask.pauseId`                 |

The channel's side authenticates who answers a `Channel` pause (Slack, a ticket system, an admin
panel already knows the manager); the framework adds no permission model of its own — it checks that
`actor` is given and records it on the pause and in `onExecutionResume` (`event.actor?.id`).
**`pauseId` is the right to answer**: a cryptographically random 128-bit token made once per pause,
before the first `send` — a retried `send` gets the same one, so it is safe as the idempotency key
towards Slack, mail or a ticket system — and `result.pending` and `onExecutionPause` leave it out of a
`Channel` pause, so the token never leaves the channel's server side. A `ThreadOwner` pause answered
with `actor`, or a `Channel` pause with `ownerId` (or without `actor`), is
`PauseError.PermissionDenied` (`pause.permission-denied`); the pause keeps waiting. A concrete `@Channel` a tool
names as is is answered by the thread's owner. The resumed pass runs as the
thread's owner (`executionContext.ownerId`), whoever answered.

## A pause's life

Every pause is a record of the application's `PausedExecutionRepository`
([App → infrastructure](App); the application's `@DatabaseStorage` driver creates it), keyed
by the waiting step's idempotency key, so a step re-entered — after a sibling's answer, or a retry
after a crash — finds the same `pauseId`:

| `PauseStatus` | Means                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| `Pending`     | waiting; `isSent` once its channel's `send` returned                                     |
| `Resolved`    | a resume recorded its decision (atomically, from `Pending` only); the holder takes it    |
| `Taken`       | its step took the decision and went on — or its channel decided at once                  |
| `Cancelled`   | closed with no answer: a sibling failed under `FailFast`, its launch's quorum was decided, the thread was cancelled, the tree ended, or the deadline passed with nobody answering |

An answer to anything but `Pending` → `PauseError.Closed` (`pause.closed`: `pauseId`, `tenantId`,
`reason: PauseClosedReason` — `answered`, `expired`, `cancelled`, `withdrawn`, `tree-ended`,
`reassigned` —, `closedAt`; its message names the pause by its `pauseKey`, never its id), checked
before a reply's interpreter is called: a double click, a late answer to a withdrawn question. An
answer that was recorded and then closed not taken is refused `answered`. `NotPausedError` stays for
the thread-level paths only. Over [A2A](A2A) the same refusal is `-32004` with `a2a.pause-closed`. Each record also says how it was resolved (`PauseResolution`), with
its answer (`answer: PauseAnswer` — the decision, who answered, what reading a reply cost) and when
(`askedAt`, `resolvedAt`, on the application's `Clock`):

| `PauseResolution` | How                                                                   | Status      |
| ----------------- | --------------------------------------------------------------------- | ----------- |
| `Decided`         | its channel answered `ChannelOutcome.decided(…)` — the call never paused | `Taken`  |
| `Replied`         | `awaitReply()`, then `app.resume` (a `decision` or a `reply`)          | `Resolved` → `Taken` |
| `Withdrawn`       | a `FailFast` sibling failed, or its launch's quorum was decided, before an answer | `Cancelled` |
| `Cancelled`       | `app.cancel` before an answer                                          | `Cancelled` |
| `TreeEnded`       | its tree finished or failed before an answer                           | `Cancelled` |
| `Expired`         | its deadline passed and the channel did not decide (`PauseExpiration.fail()`, or no handler), or a run's deadline bound it | `Cancelled` |
| `DecidedOnExpiry` | its deadline passed and the channel decided (`PauseExpiration.decide(…)`) — [A deadline for the answer](#a-deadline-for-the-answer-941) | `Resolved` → `Taken` |
| `Reassigned`      | the pause was moved to another addressee (`app.reassignPause`, [Reassigning a pause](#reassigning-a-pause-to-someone-else-946)); its replacement waits on | `Cancelled` |

What a caller of `app.resume` is told for a pause that is closed is the same list as `PauseClosedReason`:
`answered`, `expired`, `cancelled`, `withdrawn`, `tree-ended`, `reassigned` — a pause whose deadline
passed is `expired` from that moment, before the expiry look has moved its tree. A pause is **told to the channel and the listeners** under those names too
([Telling the channel and the listeners](#telling-the-channel-and-the-listeners-940)).

**Retention** (#267 S107): a resolved record (`Taken`, `Cancelled`) is kept
`@Application({ retention: { pauseRecords } })` after it was resolved — default `hours(24)` — and then
removed by the [recovery sweep](Several-instances#recovery) (every 30 s, on the `Clock`) through
`PausedExecutionRepository.deleteByResolvedAtBefore(cutoff)`. Within the window a late answer gets
`PauseError.Closed`; after it the id is unknown — `PauseError.UnknownPause`. A `Pending` pause (and a
`Resolved` one no pass took yet) is never removed, however old. When the tree ends — finished,
failed or cancelled — its stored paused run is removed (only that run's, never a later run of the
thread) and every pause it still has is closed: a waiting one `Cancelled` (`PauseResolution.Cancelled`,
after an `app.cancel`) or `TreeEnded`; a `Resolved` one — an answer no step consumed, a cancel won
over it — closed *not taken*: its answer and who gave it are kept and the answer log says so. A step
marks its answer `Taken` the moment it consumes it, before it acts, so an answer whose tool ran stays
`Taken` whatever fails after, and a pass that is stopped takes nothing. The sweep removes closed
records after the retention like any other, writing a missing log entry first (#939, #910); before,
a cancelled pass left its `Resolved` pause and paused run forever. `app.cancel` of a resting tree
marks the tree unwinding and moves its root's record off `paused` first, then removes the paused run
and closes the pauses (#1132): an instance that dies between two of these leaves a `running` root the
recovery sweep ends, or a tree a second `app.cancel` ends (it answers `true`), never a pause open
under a run that is gone.

## Who answered: `result.record.pauses`

`{ includeRecord: true }` on `execute` / `resume` returns the execution record
([Observability → the execution record](Observability)); its `pauses` are the audit trail — every
resolved pause of the tree, in the order they were asked:

| Field                    | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `pauseId`                | its id — `undefined` for a `PauseRespondent.Delegate` pause (only its channel has it) |
| `executionId`            | the execution it waited in: the root's, or a child's (#267 S124)               |
| `step`                   | the waiting step: agent (its `ComponentRecord`), node, visit, copy, item, tool call, the loop's `toolLoopIteration` and `validationAttempts` (`StepRecord`, #268) |
| `target`, `respondent`       | the channel asked and who may answer                                           |
| `actor`             | who answered — the person: the `ownerId` / `actor` of `app.resume`; `undefined` when decided at once, withdrawn or cancelled (0.1.0's `responder` alias is gone, #1307d) |
| `resolution`             | `PauseResolution`                                                              |
| `askedAt`, `resolvedAt`  | ISO 8601, the application's `Clock`                                            |
| `decision`               | what was decided, masked by the application's PII policies; `undefined` when withdrawn or cancelled |
| `asked`                  | what was asked, masked (#688): an approval's call as the agent made it — its tool and own arguments, before any correction a reply made — or a question's ask; beside `decision` it makes every change auditable |

The list is the permanent history: each entry is written when its pause is resolved — answered,
decided at once, withdrawn or cancelled — into the execution records
(`ExecutionRecordRepository.savePauseAnswer(tenantId, rootExecutionId, answer)`, once per pause of a
tree — by tenant, `rootExecutionId` and step key, #676: a step key names no tree, so another tree's
pause under the same key keeps its own answer), and
read back with `findPauseAnswersByTenantIdAndRootExecutionId`. The pause records are operational
state and are never read for it: the retention above removes a pause record, never its entry, so an
execution paused for days still lists every pause it was asked.

**Each child's own pauses** (#267 S124 c): a child execution's record — in `result.children` and
`result.record.children` alike ([Workflow as a step](Workflow-as-a-step)) — lists the pauses its own
steps asked as `ChildExecutionRecord.pauses` (the entries whose `executionId` is the child's, a
grandchild's in its own record), masked like the execution record; the root's `record.pauses` keeps
the whole tree's. A per-item launch whose children each pause gives each child's record its own
entry (its `step.itemIndex` the child's item).

**`FailFast` drops paused siblings** (#273 S21): a branch that fails cancels its launch, and its paused
siblings' pauses are withdrawn — the tree goes on to the join (its `.onError(…)`, else the
execution fails with the branch's error) instead of waiting for answers nobody needs. The join
runs in the pass that takes the withdrawal, and it still gets the error object the branch threw:
`.onError(E, …)` matches by class and cause chain as always — `.onError(PaymentDeclinedError,
…)` and `.onError(StepFailedError, …)` both take an agent that failed with a domain error, and
without a handler the execution rejects with that same `AgentFailedError`. A channel whose `send`
throws (not cancelled) fails the asking agent's step: `AgentFailedError`, the channel's error as its
`cause` — never a tool error the model reads. A join's
`deadline` counts elapsed time on the application's `Clock`, pauses included ([Parallel](Parallel)).

**A pause inside a child is its branch's** (#337): a pause records the launch branches it waits
under — its own step and every step that launched one of its executions — so a `FailFast` failure
withdraws a sibling **child's** pause under `.forEachItem(toWorkflow(…), …)` too, at any depth, and the
execution fails (or takes its `.onError(…)`) in the same call instead of resting paused.

**A decided quorum drops its waiting branches** (#337, [Parallel → Quorums](Parallel#pause-resume-recovery)):
once a `.joinQuorum(…)` / `.joinQuorumGroups(…)` is decided — `max` counted, a group won, the
deadline passed, it can no longer be reached, or it is found decided when a resume or a recovery
rebuilds it — every pending pause of the launch's unfinished branches is withdrawn
(`PauseResolution.Withdrawn`): the join runs in the same call, `result.pending` is empty and a late
answer gets `PauseError.Closed` (`reason: withdrawn`). A deadline that passes while the tree rests (every branch waiting,
nothing running) withdraws nothing until the tree moves again: the next pass — a resume, a recovery
— finds the quorum decided, cancels the unfinished branches and withdraws their pauses then.

## Telling the channel and the listeners (#940)

A pause that closes is told to the channel that asked and to the application's listeners —
**at least once**, also when the instance that closed it dies a moment later. A channel that posted
a question somewhere — buttons in Slack, a link in a mail — takes it back, or marks it answered by
whom, from `onPauseClosed(event)`; a back office or a ticket system follows every pause through a
`@ChannelListener`. Both are optional: a channel that overrides no hook has no mailbox, and a pause
costs it nothing. (#942: `onPauseTimeoutChanged` and `onPauseExpiring` are told the same way — a channel that
overrides any of the four notices has a mailbox.)

<!-- snippet-context
import { inline, Injectable, Ttl } from "@agboss/core";
import { Text } from "@agboss/core/dto";
@Injectable()
export class SlackClient {
  postApproval(_replyKey: string, _text: string): Promise<void> {
    return Promise.resolve();
  }
  closeApproval(_replyKey: string, _text: string): Promise<void> {
    return Promise.resolve();
  }
}
export class RefundRequest {
  @Text() orderId!: string;
}
// @snippet
import { Agent, Application, EmptyEnvironment, Tool, Workflow, WorkflowFinish, WorkflowStart, onStart } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
@Tool({ name: "refund-tool", description: "Refunds an order", input: RefundRequest, output: RefundRequest, approval: RefundToolApproval })
export class RefundTool {
  execute(input: RefundRequest): Promise<RefundRequest> {
    return Promise.resolve(input);
  }
}
@Agent({ name: "refund-agent", description: "Refunds", prompt: inline("Refund."), model: "moonshotai/kimi-k2.6", tools: [RefundTool] })
export class RefundAgent {}
@WorkflowStart({ name: "refund-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class RefundWorkflowStart {}
@WorkflowFinish({ name: "refund-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class RefundWorkflowFinish {}
@Workflow({
  name: "refund-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(RefundWorkflowStart).toAgent(RefundAgent).toFinish(RefundWorkflowFinish)],
  providers: [SlackClient],
})
export class RefundWorkflow {}
@Application({
  name: "refund-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RefundWorkflow],
  providers: [SlackRefundApprovalChannel],
})
export class RefundApplication {}
-->

```ts
import { Channel, ChannelOutcome, ExecutionContext, PauseRespondent, PauseClosedReason, type ChannelAsk, type ChannelPauseClosedEvent, ExternalTask, ToolApproval } from "@agboss/core";
import { hours } from "@agboss/core/units";

@ToolApproval({
  name: "refund-tool-approval",
  description: "Approves a refund",
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class RefundToolApproval {}

@Channel({
  name: "slack-refund-approval-channel",
  description: "Asks a manager in Slack",
  deps: [SlackClient, ExecutionContext],
  target: RefundToolApproval, ttl: hours(1),
})
export class SlackRefundApprovalChannel {
  constructor(
    private readonly slackClient: SlackClient,
    private readonly executionContext: ExecutionContext,
  ) {
  }

  async send(
    ask: ChannelAsk<RefundToolApproval>,
  ): Promise<ChannelOutcome<RefundToolApproval>> {
    const { orderId } = ask.input;
    const tenantId = this.executionContext.tenant.tenantId;
    await this.slackClient.postApproval(ask.pauseId, `Refund order ${orderId} (${tenantId})?`);
    return ChannelOutcome.awaitReply();
  }

  // at least once whenever a pause this channel sent closes; deduplicate by event.deliveryId
  async onPauseClosed(event: ChannelPauseClosedEvent<RefundToolApproval>): Promise<void> {
    const { orderId } = event.input;
    const why =
      event.reason === PauseClosedReason.Answered
        ? `answered by ${event.actor?.id ?? "someone"}`
        : event.reason;
    await this.slackClient.closeApproval(event.pauseId, `Refund of order ${orderId}: ${why}`);
  }
}
```

- **What a channel gets** — `ChannelPauseClosedEvent<Role>`: the `pauseId` and `value` as `send` got
  them, `reason: PauseClosedReason` (`Answered`, `Expired`, `Cancelled`, `Withdrawn`, `TreeEnded`),
  `closedAt`, and for an answer `actor` (the resume's `actor`, or the thread's owner) and the
  `answer` (masked by the PII policies), and `deliveryId`. The channel hears an answer **given
  elsewhere** too — a manager approves in the back office, the Slack message loses its buttons — and
  its own. `onPauseAnswerNotTaken(event)` is told, after the `closed`, when a recorded answer is never
  applied because its run ended first (`Cancelled` / `TreeEnded`, with the answer).
- **Written with the change, delivered by any instance** — the notice goes into the same store
  transaction as the pause's change: no close without its notice, no notice without its close. Any
  instance claims it, so a crash between the close and the delivery, or between the delivery and its
  acknowledgement, still delivers it: the receiver may be told twice, under the same `deliveryId`,
  never zero times. **`deliveryId` is the idempotency key** of one notice to one receiver — the same on
  every redelivery, different for every other notice; deduplicating by it is the receiver's job. Per
  pause and receiver the order is kept: `opened` before `closed`, `closed` before `answerNotTaken`.
- **Where it runs** — in the pause's execution frame (its `ExecutionContext`: tenant, the project's
  fields, the thread's owner, the waiting step), under its tool's `timeout` (a question's, a
  listener's: 30 s) on the application's `Clock`: `executionContext.signal` aborts at the timeout and
  the call is cut off. A run, a resume and a cancel never wait for a receiver.
- **Retried, then set aside** — a hook that throws or runs past its timeout is retried after 1 s, 2 s,
  4 s … (at most 5 min) and logged each time (`pause.notice-failed`, `LogLevel.Warn`: the receiver, the
  pause's `pauseKey` and a fixed problem code — never the error's text); once the first undelivered
  notice is older than `retention.pauseRecords` the mailbox is set aside — `pause.notice-dead`
  (`LogLevel.Error`), counted — and the other pauses' notices go on flowing. There is no API to
  deliver a set-aside notice again: retries and queueing are the receiver's.
- **Never for a pause its channel decided at once** (`ChannelOutcome.decided`) or never sent (its
  `send` threw). A pause opened before a listener was added has no `opened` for it (its mailbox did not
  exist); a receiver a deploy removed has its mailboxes set aside by the recovery sweep after the
  retention (`pause.notice-recipient-unknown`, once per mailbox) and its pauses removed with theirs.
- Tests: `mockService(SlackRefundApprovalChannel).onPauseClosed` records the calls; a contract that
  resolves to a mocked implementation (a target, any `extends`) gets the mock too.

### `@ChannelListener`: every pause of the application

<!-- snippet-context
import { Injectable } from "@agboss/core";
@Injectable()
export class BackOfficeApi {
  track(_pauseKey: string, _channel: string, _ask: unknown): Promise<void> {
    return Promise.resolve();
  }
  settle(_pauseKey: string, _reason: string, _by: string | undefined, _answer: unknown): Promise<void> {
    return Promise.resolve();
  }
}
-->

```ts
import { ChannelListener, type ChannelListenerClosedEvent, type ChannelListenerHandler, type ChannelListenerOpenedEvent } from "@agboss/core";

@ChannelListener({ name: "back-office-pause-listener", deps: [BackOfficeApi] })
export class BackOfficePauseListener implements ChannelListenerHandler {
  constructor(private readonly backOffice: BackOfficeApi) {}

  async onPauseOpened(event: ChannelListenerOpenedEvent): Promise<void> {
    await this.backOffice.track(event.pauseKey, event.channel ?? "", event.input);
  }

  async onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    await this.backOffice.settle(event.pauseKey, event.reason, event.actor?.id, event.answer);
  }
}
```

List it in `@Application({ providers })`: the container creates it at start (its `onInit` /
`onStart` run with the application's), one instance for every workflow. It hears `onPauseOpened`
(its channel was asked) and `onPauseClosed` of **every** pause — also those of child workflows
(`executionId` is the child's) — and, with the optional `onPauseAnswerNotTaken`, the answers never
applied. An event carries the safe context — `pauseKey`, `tenantId`, `rootExecutionId`,
`executionId`, `threadId`, `workflow`, `step`, `kind`, `channel`, `respondent`, the masked `ask`,
`askedAt`, `expiresAt` — and `deliveryId`. Assembly rules: `[name.not-kebab-case]`,
`[pause-listener.duplicate-name]`, `[pause-listener.not-a-handler]`;
`agboss describe` lists the listeners.

- **A correlation key, never the right to answer** — a `PauseRespondent.Delegate` pause's id is the
  right to answer it (#267), so a listener gets `pauseKey` (`pauseKeyOf(tenantId, pauseId)`, one-way)
  and no `pauseId`; the id of a `PauseRespondent.Owner` pause is no secret (the owner check
  guards it) and is always there. `@ChannelListener({ includePauseIds: true })` declares a **trusted
  component**: its events carry the raw id of channel pauses, so it holds the right to answer every
  channel pause of the application (`app.resume` still needs `actor`).

## Expiry in parallel launches (#945)

A pause asked in a **quorum** branch is bound by the quorum's deadline (`PauseExpiryBound.Quorum`, the smaller of
it and the pause's own and the run's): at it the tree wakes by itself — no answer, no resume — and the quorum
decides. The branch ends `BranchStatus.Expired`: it did not vote, never fails the launch, whatever its
its `skip()`; `QuorumNotReachedError.expired` names the branches that expired. In a plain `.join()` an expired
branch follows its `.onError(E, skip())`: a skipped one is dropped, else it fails the launch with the branch's
`PauseExpiredError` for `.onError(PauseExpiredError, …)` and withdraws the branches still waiting. The side
path reads the answers already settled — each branch output as an `optional(XDto)` input of its first step —
so it continues or escalates without asking anyone again. Each branch that had answered hears
`onPauseJoinFailed` (`ChannelPauseJoinFailedEvent`: `launch`, `errorCode`, `at`; a listener's
`ChannelListenerJoinFailedEvent`) once: "the parallel step this answer belongs to did not collect all its answers;
its error path is running" — neutral, the handler may still carry the work on. A channel that overrides it has a
mailbox like for the other notices.

A child workflow cannot be a quorum branch: a quorum launches agents only, so the pause that the quorum's deadline binds is always an agent's own (an approval or a question it asks in its tool loop).

## A deadline for the answer (#941)

Every pause has a deadline — an approval nobody answers should escalate, or go on with a default,
not wait forever. The deadline belongs to the pause target: `@ToolApproval({ timeout: hours(24) })`
and `@ExternalTask({ timeout: hours(24) })` require one (at least `seconds(1)`; a working duration
counts by the target's `calendar`, [below](#deadlines-in-working-time-944)); a channel may shorten
it with its own `@Channel({ timeout })`, never lengthen it. There are no per-step or per-tool
overrides (0.1.0's `.toExternalTask(Role, { expiresIn })` and `@Tool({ expiresIn })` are gone): a
different deadline is a different target, and a profile's `toolApprovals` / `externalTasks` shelf
changes the number without touching the code. `[limits.timeout-invalid]` for a value under
`seconds(1)` or no finite duration. The absolute deadline is fixed **when the pause is made** — a
deploy that changes `timeout` never moves an open pause — as the smaller of it and the run's
deadline (`app.execute(…, { deadline })`, a mesh caller's remaining time): a tie goes to the run.
`result.pending[].expiresAt` and the `onExecutionPause` event carry it; `agboss describe` prints each
target's `timeout`.

**A worked example: ask the manager for a day, then the director.** The tool approval has a deadline;
the flow's `.onError(PauseExpiredError, …)` is the escalation — a question step on a side path.

```ts file=desk-flow.ts
import { Action, Application, Channel, ChannelOutcome, EmptyEnvironment, Injectable, PauseRespondent, PauseExpiredError, Workflow, WorkflowFinish, WorkflowStart, onStart, toExternalTask, type ActionHandler, type ChannelAsk, type InputOf, type OutputOf, toAction, toFinish, ExternalTask, ToolApproval, Ttl } from "@agboss/core";
import { Bool, Text } from "@agboss/core/dto";
import { hours } from "@agboss/core/units";

// the chat the channels talk to: yours is a Slack or Teams client
@Injectable()
export class DeskChat {
  ask(_to: string, _pauseId: string, _text: string): Promise<void> {
    return Promise.resolve();
  }
}

export class DeskOrderDto {
  @Text({ prompt: "the order" })
  orderId!: string;
}

export class DeskDecisionDto {
  @Bool({ prompt: "whether the refund goes on" })
  approved!: boolean;
}

export class DeskDoneDto {
  @Text()
  status!: string;
}

// who is asked first, and for how long: the deadline belongs to the target
@ExternalTask({
  name: "desk-manager-external-task",
  description: "Asks the manager to approve a refund",
  input: DeskOrderDto,
  output: DeskDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class DeskManagerExternalTask {}

@Channel({
  name: "desk-manager-channel",
  description: "Asks the manager in the chat",
  deps: [DeskChat],
  target: DeskManagerExternalTask, ttl: hours(1),
})
export class DeskManagerChannel {
  constructor(private readonly chat: DeskChat) {
  }

  async send(ask: ChannelAsk<DeskManagerExternalTask>): Promise<ChannelOutcome<DeskManagerExternalTask>> {
    await this.chat.ask("manager", ask.pauseId, `Refund order ${ask.input.orderId}?`);
    return ChannelOutcome.awaitReply();
  }
}

@ExternalTask({
  name: "desk-director-external-task",
  description: "Asks the director when the manager did not answer",
  input: DeskOrderDto,
  output: DeskDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class DeskDirectorExternalTask {}

@Channel({
  name: "desk-director-channel",
  description: "Asks the director in the chat",
  deps: [DeskChat],
  target: DeskDirectorExternalTask, ttl: hours(1),
})
export class DeskDirectorChannel {
  constructor(private readonly chat: DeskChat) {
  }

  async send(ask: ChannelAsk<DeskDirectorExternalTask>): Promise<ChannelOutcome<DeskDirectorExternalTask>> {
    await this.chat.ask("director", ask.pauseId, `The manager did not answer: refund ${ask.input.orderId}?`);
    return ChannelOutcome.awaitReply();
  }
}

@WorkflowStart({ name: "desk-workflow-start", description: "A refund request", input: DeskOrderDto })
export class DeskWorkflowStart {}

@WorkflowFinish({ name: "desk-workflow-finish", description: "The outcome", output: DeskDoneDto })
export class DeskWorkflowFinish {}

@Action({
  name: "record-desk-action",
  description: "Records the manager's decision",
  input: { order: DeskOrderDto, decision: DeskDecisionDto },
  output: DeskDoneDto,
})
export class RecordDeskAction implements ActionHandler<RecordDeskAction> {
  execute({ order, decision }: InputOf<RecordDeskAction>): Promise<OutputOf<RecordDeskAction>> {
    return Promise.resolve({
      status: `${order.orderId}: ${decision.approved ? "refunded" : "refused"}`,
    });
  }
}

@Action({
  name: "record-escalated-desk-action",
  description: "Records the director's decision",
  input: { order: DeskOrderDto, decision: DeskDecisionDto },
  output: DeskDoneDto,
})
export class RecordEscalatedDeskAction implements ActionHandler<RecordEscalatedDeskAction> {
  execute({
    order,
    decision,
  }: InputOf<RecordEscalatedDeskAction>): Promise<OutputOf<RecordEscalatedDeskAction>> {
    return Promise.resolve({
      status: `${order.orderId}: the director ${decision.approved ? "refunded" : "refused"}`,
    });
  }
}

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeskWorkflowStart)
      .toExternalTask(DeskManagerExternalTask)
      .onError(
        PauseExpiredError,
        toExternalTask(DeskDirectorExternalTask)
          .toAction(RecordEscalatedDeskAction)
          .toFinish(DeskWorkflowFinish),
      )
      .toAction(RecordDeskAction)
      .toFinish(DeskWorkflowFinish),
  ],
  providers: [DeskChat],
})
export class DeskWorkflow {}

@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow],
  channels: [DeskManagerChannel, DeskDirectorChannel],
})
export class DeskApplication {}
```

After 24 hours the manager's pause closes `expired`, the step fails with `PauseExpiredError`, the side
path asks the director (a pause of its own, with its own 24 hours) and its answer goes on to its own
action. A question with no `.onError` for it fails the run with `PauseExpiredError`.

**A default answer instead of a failure.** The target that decides what "nobody answered" means
implements `PauseExpiryHandler` — an `onExpired(ctx)` on the target class, not on its channel:

```ts no-check: a variant of the first example's target, which is defined in the page's hidden desk-flow file
import { ExternalTask, PauseExpiration, PauseRespondent, type ExpiredContext, type PauseExpiryHandler } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { DeskDecisionDto, DeskOrderDto } from "./desk-flow.js";

// the manager's target again, now deciding what "nobody answered" means (use it instead of the first)
@ExternalTask({
  name: "desk-manager-external-task",
  description: "Asks the manager to approve a refund",
  input: DeskOrderDto,
  output: DeskDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class DeskManagerExternalTask implements PauseExpiryHandler<DeskManagerExternalTask> {
  // once per expiry, in the pause's frame; it may only read — a crash may run it again
  onExpired(_ctx: ExpiredContext<DeskManagerExternalTask>): PauseExpiration<DeskManagerExternalTask> {
    // a refusal the target makes, recorded as its own; PauseExpiration.fail() is the default
    return PauseExpiration.decide({ approved: false });
  }
}
```

The step goes on with that answer as if the manager had answered, `actor` the
target's name in the audit trail (`PauseResolution.DecidedOnExpiry`); `decide` is typed by the target's
answer.

**The deadline is hard.** An answer at or after it is refused with `PauseError.Closed` (`reason:
expired`, `closedAt` the deadline) — before a reply's interpreter reads anything, and in the store's
own compare-and-set (`expires_at > at`), so an answer and the expiry racing at the deadline leave
exactly one winner, whatever the instances' clocks. Within seconds the tree moves.

**What an expiry means** is the channel's call. A channel (`implements PauseExpiryHandler<Role>`)
may answer `onPauseExpired(ask)` — `ask` is what `send` got — with:

- `PauseExpiration.fail()` (the default without the method): the step fails with `PauseExpiredError`
  (`step.pause-expired`: `step`, `stepKind`, `channel`, `kind`, `expiresAt`; never the pause's id) —
  `.onError(PauseExpiredError, …)` escalates, a question step's side path may ask the next person.
  Inside an agent an expired approval, or a question the agent asked as a tool, fails the whole
  **agent step**, its spend kept, and none of the move's calls ran;
- `PauseExpiration.decide(answer)`: the step goes on with that answer, validated like a resume's
  and recorded as answered **by the channel** (`PauseResolution.DecidedOnExpiry`, the log's
  `actor` is the channel's name); `onExecutionResume` says `ResumeReason.Expired`. An
  approval decided `{ approved: true }` runs its tool with no person having looked — choose it
  knowing that; `{ approved: false, reason }` is read by the model as a refusal by the channel.
- `PauseExpiration.reassign({ assignees, timeout?, reason? })` (#1310): the pause goes on waiting, for
  other assignees, under a new deadline (`timeout` after now, else the channel's `expiresIn`, never
  past the run's or a quorum's bound). The old pause closes `reassigned`, a new one (a new id, the
  old `trail` plus a `reassigned` entry, no reminder) is asked of the same channel by the re-send
  look, and the tree rests paused again. A request that is not valid, or a deadline already past,
  expires the pause as `fail()`; a pause bound by the run's or a quorum's deadline is never
  reassigned.

The handler runs under the tree's lease in the pause's frame under the tool's `timeout`, **once per
expiry**: a crash before its decision was recorded may run it again, and one decision is recorded —
so it must only read. A throw, a timeout, a value that is no `PauseExpiration` or an invalid answer
makes the expiry `fail()` with an `PauseError.ExpiryHandlerFailed` (`pause.expiry-handler-failed`, `problem`: `handler-failed`
| `handler-timeout` | `answer-invalid`) as the cause; it is logged (`pause.expiry-handler-failed`,
never the error's message). An instance that stops (`app.close()`) while a handler waits records no
decision: another instance's look expires the pause.

**A run's deadline bounds every pause.** A pause the run's deadline bound fails the run with
`DeadlineExceededError` at the deadline — also while paused — and asks the channel nothing. A
mesh caller's remaining time bounds the receiver's pause; a child's pause the root's deadline.

**A cancel always beats an expiry.** `app.cancel` after the deadline cancels the run and closes the
pause `expired`; a cancel request found when the look takes the tree, or written while the handler
runs, or after its decision was recorded and before the run goes on, ends the tree as cancelled with no
decision applied and `app.cancel` returning `{ cancelled: true }` (#1073: every cancel writes its request
where the expiry reads it). Over [A2A](A2A) the task goes
`INPUT_REQUIRED` → `WORKING` → `FAILED` (`step.pause-expired`) or `COMPLETED`; a follow-up before
the look is `-32004 a2a.pause-closed` (`reason: expired`). How the instances do it:
[Several instances → Expiring a pause](Several-instances#expiring-a-pause-941).

## Extending a pause and reminding before its deadline (#942)

**A reminder.** `@ToolApproval({ timeout: hours(24), remindBefore: hours(2) })` (or an `@ExternalTask`) makes the channel's
optional `onPauseExpiring(event)` and a `@ChannelListener`'s optional `onPauseExpiring` hear "expiring at
`event.expiresAt`" two hours before the deadline — **once per deadline**, whatever the number of
instances: the pause timers' reminder look writes the notice and clears the pause's `remindAt` in one
store transaction, so the instance that gets there first reminds and the rest find nothing to do. No
lease is taken and nothing of the run moves. `remindBefore` is a positive finite duration shorter than the
target's own `timeout` (`[pause.remind-before-invalid]`). The reminder time is fixed when the pause
is made — `expiresAt − remindBefore`, so a pause the run's deadline bound is reminded before **that**
deadline — and again by an extension. A `remindBefore` shorter than the pause timers' 5 s
tick can be skipped, since a tick may fall on none of its window (`[pause.remind-before-below-tick]`, a
warning; an error under `--strict`). The look pages through the due reminders with a
keyset cursor and hands each to the store without waiting, like the expiry look: another application's
due pauses on a shared store never hide yours.

```ts
import { Channel, ChannelOutcome, ChannelListener, type ChannelAsk, type ChannelPauseExpiringEvent, type ChannelListenerClosedEvent, type ChannelListenerExpiringEvent, type ChannelListenerHandler, type ChannelListenerOpenedEvent } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { DeskChat, DeskManagerExternalTask } from "./desk-flow.js";

// the manager's channel, told two hours before the deadline of every pause (the target has
// `remindBefore: hours(2)`, see the first example)
@Channel({ name: "desk-manager-channel", description: "Asks the manager in the chat", deps: [DeskChat],
  target: DeskManagerExternalTask, ttl: hours(1),
})
export class DeskManagerChannel {
  constructor(private readonly chat: DeskChat) {
  }

  async send(ask: ChannelAsk<DeskManagerExternalTask>): Promise<ChannelOutcome<DeskManagerExternalTask>> {
    await this.chat.ask("manager", ask.pauseId, `Refund order ${ask.input.orderId}?`);
    return ChannelOutcome.awaitReply();
  }

  // once per deadline, whatever the number of instances; at least once, so a chat message
  // that is sent twice must be harmless — deduplicate by event.deliveryId
  async onPauseExpiring(event: ChannelPauseExpiringEvent<DeskManagerExternalTask>): Promise<void> {
    await this.chat.ask("manager", event.pauseId, `Order ${event.input.orderId}: answer by ${event.expiresAt}`);
  }
}

// a listener hears the reminder of every pause that has one — here a pager for the on-call
@ChannelListener({ name: "on-call-pause-listener", deps: [DeskChat] })
export class OnCallPauseListener implements ChannelListenerHandler {
  constructor(private readonly chat: DeskChat) {}

  onPauseOpened(_event: ChannelListenerOpenedEvent): Promise<void> {
    return Promise.resolve();
  }

  onPauseClosed(_event: ChannelListenerClosedEvent): Promise<void> {
    return Promise.resolve();
  }

  async onPauseExpiring(event: ChannelListenerExpiringEvent): Promise<void> {
    await this.chat.ask("on-call", event.pauseKey, `A ${event.channel} pause expires at ${event.expiresAt}`);
  }
}
```

**An extension.** `await app.extendPause({ pauseId, expiresIn: hours(24) }, { actor })` — the
`ownerId` for a thread owner's pause: whoever may answer may extend; the options are
`PauseCallerOptions`, the caller fields of `resume`'s and none of a run's — moves an open pause's deadline
to `now + expiresIn` and returns `PauseExtension { pauseKey, expiresAt, previousExpiresAt }`. The channel's
optional `onPauseTimeoutChanged(event)` and a listener's `onPauseTimeoutChanged` hear "extended until `event.expiresAt`"
(`previousExpiresAt` too), and the reminder is made again before the new deadline. It is refused:

- a pause that is closed, or already past its deadline — `PauseError.Closed` (`reason: expired`);
- a pause with **no deadline** — none is ever added to it — and a new deadline that is not later than the
  current one — `ValidationError.DtoInvalid` (`dto: "ExtendPauseRequest"`);
- a deadline past the one the pause was made under — its run's (or a quorum's): exactly that deadline is
  allowed, and a pause extended to it expires there as the run's own, as one made with it does — also
  `ValidationError.DtoInvalid`, naming that deadline;
- another tenant's pause or an unknown id — `PauseError.UnknownPause`.
- eight lost races in a row against other extensions of the same pause — `PauseError.UpdateContended`
  (`pause.update-contended`; nothing changed, trying again is safe).

```ts
import { hours } from "@agboss/core/units";
import type { App, PauseExtension } from "@agboss/core";

declare const app: App;
declare const pauseId: string; // the id the channel was sent

// the manager asks for one more day; the credential of a `Delegate` target is `actor`
const extension: PauseExtension = await app.extendPause(
  { pauseId, expiresIn: hours(24) },
  { tenantId: "acme", actor: { id: "manager-17" } },
);
console.log(extension.expiresAt, extension.previousExpiresAt);
```

The store applies the extension atomically: its compare-and-set applies it only while the pause is open, over
the deadline the caller read (`PauseDeadlineChange.previousExpiresAt`) and to a deadline later than the stored
one. So exactly one of an extension and an expiry at one tick wins, and of two extensions at once one wins and the
other re-reads: it is refused ("not later", `ValidationError.DtoInvalid`) when the winner's deadline is at least as late,
and otherwise applied over the new deadline — the deadline never shortens, "extended" is told once by the writer
that won, and `previousExpiresAt` is the deadline that write replaced. A store of your own does the same in its
`extendByTenantIdAndPauseId` (the contract suite has the cases). An extended pause answered on any
instance, an expiry look on any instance, all read the new deadline from the record.

### Reassigning a pause to someone else (#946)

The approver is on leave: the request must go to a deputy, and the agent or the step must not run again.
`await app.reassignPause({ pauseId, assignees: ["deputy-3"] }, { actor })` — the `ownerId` for a thread
owner's pause: whoever may answer may reassign; `PauseCallerOptions`, as `extendPause` — moves the open pause
to another addressee of **the same channel** and returns `PauseReassignment { pauseKey }`, the new pause's key.
It is the same role's implementation that routes on `assignee` (a Slack user, an address, a queue): no other
role, no other implementation, no change of the injection (`[di.ambiguous-implementation]` stays: a channel
and its addressee are one thing), and no new deadline — the replacement keeps the deadline, its source and
its reminder; extend it separately ("An extension" above).

What the channel hears, in no fixed order:

- **`send` again** — with a **new `pauseId`**, `ChannelAsk.assignees` (the `assignee` of the call) and
  `ChannelAsk.replaces: { pauseId }`, the old message's id. A first send carries neither field. A `send`
  that returns `ChannelOutcome.decided(…)` answers the replacement at once, through the normal answer path
  (the decision validated, recorded by the store's compare-and-set, the tree moved): the answer is the
  **channel's own** — `actor` is the channel's name for a channel's pause and a thread owner's alike, never the
  owner who only reassigned it — applied once, a re-send after a crash finds it answered; a hand-over or a
  run that ended after the decision is the run's own outcome, not a failed send.
- **`onPauseClosed`** (if the channel overrides it) for the **old** message with `reason: reassigned`
  (`PauseClosedReason.Reassigned`), at least once like every notice (the same `deliveryId` on a redelivery).

The channel decides the order: it may take the buttons off the old message from `send` (it has the old id in
`replaces`) and treat the later `onPauseClosed(reassigned)` as a no-op, or the reverse. A `@ChannelListener`
hears the old pause `closed` (`reason: reassigned`) and the replacement `opened`.

What the old id does: `app.resume` with it is `PauseError.Closed` (`reason: reassigned`, `closedAt` the time
of the reassignment); the record is `Cancelled` / `PauseResolution.Reassigned` with `reassignedTo`. The
deputy's answer, with the new id, goes on: the agent's model is not called again, its loop's state and spend
are the ones it slept with, and `result.pending` lists the live pause. A quorum's or a group's branches are
several pauses: a reassignment acts on one pause, the others are unchanged.

**The new id is a capability.** It goes only to the channel (`send`'s `ChannelAsk.pauseId`) and to a
`@ChannelListener({ includePauseIds })`; never to the caller (the call returns the key), a log, or a listener
without `includePauseIds`.

It is refused:

- a pause that is closed — `PauseError.Closed` with the reason of its close — or whose deadline is at or before
  the write (`reason: expired`, also when the look has not expired it yet);
- an `assignee` that is no key's text (#589: non-empty, no control or invisible characters, NFC) —
  `ValidationError.DtoInvalid` (`dto: "ReassignPauseRequest"`);
- another tenant's pause or an unknown id — `PauseError.UnknownPause`; a caller that may not answer it —
  `ExecutionError.ThreadOwnerMismatch` / `PauseError.PermissionDenied`;
- a pause its channel decided at once: it never waited, it is closed `answered`;
- a pause whose channel is still being asked for the first time (its step's `send` has not returned) —
  `PauseError.UpdateContended` (`pause.update-contended`; nothing changed, trying again once the send returned
  is safe): the step acts on what `send` returns, so a change written meanwhile is one it would never see;
- a change planned against a pause that changed before the write (another reassignment, an extension, its
  channel marked asked) — `PauseError.UpdateContended` too. A call that sets a `timeout` counts as an
  extension against `escalationLimits.maxExtensions` whether it changes the pause in place or moves it to
  another target or channel — `PauseError.EscalationLimitExceeded` past it.

```ts
import type { App, PauseReassignment } from "@agboss/core";

declare const app: App;
declare const pauseId: string; // the id the channel was sent

// the operator hands the approval to the deputy; the credential of a `Delegate` target is `actor`
const moved: PauseReassignment = await app.reassignPause(
  { pauseId, assignees: ["deputy-3"] },
  { tenantId: "acme", actor: { id: "operator-1" } },
);
console.log(moved.pauseKey); // the new pause's key: a correlation, it answers nothing
```

**Races.** One transaction of the store makes the old pause `Reassigned` and the replacement `Pending` (unsent,
the old deadline and question, the step key `<original>~r<n>` — a second reassignment is `~r2`, never
`~r1~r1`), and writes the old pause's `closed` notices: of two reassignments at once, or a reassignment and an
answer, exactly one wins, and the loser gets `PauseError.Closed` with the reason of the winner's close. A
store of your own does the same in `reassignByTenantIdAndPauseId` (the contract suite has the cases).

**A crash between the write and the new message.** After the transaction the call asks the channel in the
pause's frame and marks the replacement sent. An instance that dies there, or a channel that fails, leaves it
`Pending` and unsent: the pause timers of every instance look for such replacements 30 seconds after they
were made and send them again — `replaces` and `assignee` as the first time — so another instance sends it
within a minute and the step never runs again. `send` is at-least-once, as a step's re-entry after a crash
already is: deduplicate by the new `pauseId`; the compare-and-set of marking it sent keeps one `opened`. The
retention keeps a reassigned pause while its replacement is stored: the step's interrupt still names it.

## List and watch pauses

`app.listPauses({ tenantId, status?, target?, expiringBefore?, limit?, after? })` is an operator's queue of one
tenant's pauses ([App](App#applistpauses-tenantid-status-target-expiringbefore-limit-after-943)): by default
the `Pending` ones, by channel name (`target`) and by deadline, 100 a page, each pause exactly once across
pages even while others open and close. A pause shows its `pauseKey` always and its `pauseId` only when the
thread's owner answers it; its `ask` is masked by its workflow's policies; a closed one carries `reason`,
`closedAt` and who answered. "What expires in the next hour":
`app.listPauses({ tenantId, expiringBefore: new Date(Date.now() + 3600e3) })`.

The instance's meter counts them ([Metrics](Metrics)): `agboss.instance.pauses.opened`, `.closed` by
`reason`, `.timeout_changed`, `.reassigned`, `.answers_not_taken`, the histogram `.time_to_answer` (human answers only, in
seconds) and the cluster gauges `agboss.cluster.pauses.notices.waiting` / `.dead`. Each change is counted
once, by the instance that applied it; labels are the workflow, the target, the channel and the reason.

## Deadlines in working time (#944)

"Approve within 2 hours" often means 2 **working** hours: a request at 17:30 on a Thursday in Tel Aviv
is due at 10:30 on Sunday, not 19:30 the same evening; lunch and holidays do not count. `expiresIn`,
`remindBefore` and `extendPause`'s `expiresIn` take working durations — `workingHours(n)`,
`workingMinutes(n)` from `@agboss/core/units`, a positive finite number (`RangeError` otherwise), at least
`seconds(1)` as a deadline — beside plain `hours(n)`. A **calendar** turns "now + N working time" into a
date; nothing else changes: the deadline is still one stored absolute instant, the expiry look, the
reminder look and the answer's compare-and-set read it from the record on every instance.

```ts no-check: a fragment of a @WorkingCalendar and an @ExternalTask — the whole application is in Configuration → workingCalendar
@WorkingCalendar({
  name: "support-working-calendar",
  week: {
    timeZone: "Asia/Jerusalem",
    days: [Weekday.Sunday, Weekday.Monday, Weekday.Tuesday, Weekday.Wednesday, Weekday.Thursday],
    hours: [{ from: "09:00", to: "18:00" }],
    breaks: [{ from: "13:00", to: "14:00" }],
    holidays: ["2026-04-22"],
  },
})
export class SupportCalendar {}

@ToolApproval({
  name: "refund-tool-approval",
  // …
  respondent: PauseRespondent.Delegate,
  timeout: workingHours(2),
  remindBefore: workingHours(1),
  calendar: SupportCalendar,
})
export class RefundToolApproval {}
```

**Where a calendar comes from.** A target's `calendar` (#1310a) names the calendar its working-time
`timeout` and `remindBefore` are counted by: a declarative `@WorkingCalendar({ week })` on an empty
class, or a `@WorkingCalendar` class that sees the tenant, the target and the assignees and may read
the application's own data (a holiday table, an HR directory) — listed in `@Application({ providers
})`, created by the application's container at start, one instance. There is no application-wide
default calendar: every target counting working time names its own. See [Configuration →
`workingCalendar`](Configuration#workingcalendar--the-calendar-of-working-time-deadlines-944). A
working duration on a target with no `calendar` is `[calendar.required-for-working-duration]`.

**Working days, and a schedule per assignee (#1310b).** `workDays(n)` counts **working days of the resolved
schedule**, not 24 hours: a working day is one local date of the grid's zone with working time — however long
its shifts — and a date with none (a weekend, a holiday) is skipped. A start in the middle of a shift counts
the rest of that date in proportion (from 13:00 of a 09:00–17:00 day, half a day is left), a fractional last
day advances `ceil(share × the date's working milliseconds)`, and a clock change makes a date shorter or
longer, never less of a day. `workHours(n)` / `workMin(n)` count real working time as before. A calendar
that is not a fixed grid implements `resolveSchedule(ctx)` and returns a `WorkingWeek.of(…)` — the core does
the DST and interval arithmetic over it, for the people the pause is assigned to (`ctx.assignees`) and the
tenant; `WorkingWeek.anyOf([…])` is a pool in several zones, any of whom may answer: working hours are
counted over the **union** of the schedules (overlapping hours once), working days are the earliest of each
schedule's own count, in its own zone. A holiday that must not go stale is a rule, `isHoliday(localDate)`
(asked once per date a walk crosses), beside `holidays`. A schedule with no working time in a year (a rule
that is always `true`) or an `anyOf([])` is refused: `[working-calendar.invalid]` at start for a declared
week, `PauseError.WorkingCalendar` (`invalid-schedule`) at run time for a resolved one.

**The grid's rule is pointwise.** An instant is working time when its local wall-clock time in `timeZone`,
on its local date, lies in some `hours` interval `[from, to)` and in no `breaks` interval, and its local
date is a working day and not a holiday. Working time between two instants is the real elapsed time of the
working instants between them. So "2 working hours" is always 2 real hours — an hour lost to a
spring-forward gap inside `hours` is simply not there (that day has one working hour less), in a fall-back
overlap each local minute occurs twice and **both** occurrences are working (a break 01:15–01:45 on New
York's 1 November is two 30-minute breaks), and nothing is counted twice or grows. `"24:00"` is the end of
the local date; a night shift is two intervals, `22:00`–`24:00` and `00:00`–`06:00`, none lost. No overnight
interval (`22:00`–`06:00`) in one entry. Time zones go through `Intl` (no new dependency).

**Computed once.** The deadline is calculated when the pause opens, **before the channel is asked**, and
stored in `expiresAt` (and `remindAt`); a re-entry of the step finds the record and never asks the calendar
again. A calendar changed later — a new holiday, another grid — does **not** move open pauses; extend them
instead. An extension computes its new deadline the same way: `calendar.add(now, expiresIn)`, in the pause's
frame. No working-time run deadline: `app.execute(…, { deadline })` stays wall-clock and, as always, the
smaller deadline wins and a tie goes to the run — a working deadline later than the run's is fine, the run's
applies (`expiryBound` `RunDeadline`).

**The reminder.** Both working, on a `WorkingWeek`-backed calendar (a grid, `resolveSchedule`, `anyOf`):
`remindAt` is walked **back** `remindBefore` of working time from the deadline along the resolved schedule
(so a deadline the run's or a quorum's bound pulled in never leaves the reminder past it), and the units
need not match (`workHours(4)` before a `workDays(3)` deadline); for a calendar of the project's own that
only adds, `remindAt = calendar.add(askedAt, expiresIn − remindBefore)` and the two must count in one unit
(`mixed-units` otherwise). A working
`expiresIn` with a plain `remindBefore`: `remindAt = expiresAt − remindBefore`; a **plain** `expiresIn` with a
working `remindBefore` is `[pause.remind-before-working-without-working-timeout]` (a calendar can only add).
`[pause.remind-before-invalid]` compares the working amounts when both are working. A reminder is kept only
when `askedAt < remindAt < expiresAt`, checked after the run's or a quorum's deadline clamped `expiresAt` —
otherwise none.

**`extendPause` with working time.** `expiresAt = calendar.add(now, expiresIn)`, the reminder from `now` as
above. A **plain** `expiresIn` for a pause whose target reminds in working time is refused with
`ValidationError.DtoInvalid` (`dto: "ExtendPauseRequest"`, `.expiresIn`: "this target reminds in working time: extend
it with workingHours / workingMinutes"); a pause whose channel has no calendar any more is refused working
time the same way. The pause is unchanged on every refusal. **The calendar may take seconds, the write is
decided at its own instant:** the deadline counts from the call's start, but whether the pause is still open
is decided with the clock read after the calendar answered (and the store's compare-and-set takes that
instant as its `at`). A deadline that passed while the calendar computed is not moved — `PauseError.Closed`,
as for a plain extension, even when the expiry is still being handled (#1148).

**A calendar that cannot answer fails closed.** A throw, a timeout (the calendar's `timeout`, `sec(30)` unless it says otherwise, on the application's
clock), an answer that is not a valid `Date`, or a date not after `from`: the step fails and **nobody is
asked, no pause record is made** — `QuestionFailedError` (a question step) or `AgentFailedError` (an agent's
approval or question tool) with a `PauseError.WorkingCalendar` as its `cause` (`pause.working-calendar`;
`calendar` its name, `problem`: `calendar-failed` | `calendar-timeout` | `not-a-date` | `not-after-start` | `invalid-schedule` | `mixed-units`;
its message never holds the calendar's own error text, which is the cause only in-process); logged as
`pause.working-calendar-failed`. The step's re-entry asks the calendar again (no record was made). An
extension that meets the same rejects with that `PauseError.WorkingCalendar`. There is no fallback to wall-clock
time: that would be a deadline nobody asked for, silently. A grid with no working time at all — an unknown
time zone, no days, a bad interval, a break outside the hours, a malformed holiday, no working minute in a
week — is `[working-calendar.invalid]` when the application starts. So is a working span the grid cannot
reach within 25 years, counting its holidays: each can cost up to a day of working time, a `1 / days`
share of a week (a holiday on a day the grid does not work counts too, so the refusal can come earlier
than the walk would fail). The walk itself stays bounded (25 years plus the holidays, then a `RangeError`,
`calendar-failed` to the step): never a loop (#1148).

## Expiry in a quorum

> **TODO (#945, not on main yet):** a pause that expires inside a quorum or a plain join —
> `BranchStatus.Expired`, the settled answers, `joinFailed` — here and in [Parallel](Parallel).

## Late answers (#939, #941)

A pause is answered once. Whoever comes later — a double click, a webhook that retries, a manager who
saw the message a minute after the deadline — gets `PauseError.Closed` (`pause.closed`), and nothing
moves: the error says **why** the pause is closed, so the answering side can tell the person.

<!-- snippet-context
import type { App } from "@agboss/core";
declare const app: App;
declare const pauseId: string;
-->

```ts
import { PauseError.Closed, PauseClosedReason } from "@agboss/core";

// the Slack webhook of "Approve": the pause may be closed by now
try {
  await app.resume({ pauseId, decision: { approved: true } }, { tenantId: "acme", actor: { id: "manager-17" } });
} catch (error) {
  if (!(error instanceof PauseError.Closed)) throw error;
  const sorry =
    error.reason === PauseClosedReason.Expired
      ? `Too late: the question closed at ${error.closedAt}`
      : error.reason === PauseClosedReason.Answered
        ? "Someone answered already"
        : `The question is closed (${error.reason})`;
  console.log(sorry); // post it back to the manager
}
```

- **The deadline is the line** — an answer at or after `expiresAt` is `expired`, even if the expiry
  look has not moved the run yet ([A deadline for the answer](#a-deadline-for-the-answer-941)).
- **The reply is not read** — the check comes before a reply's interpreter is called, so a late reply
  costs no model call.
- **A recorded answer can still lose.** When an answer was recorded and then the run ended first (a
  cancel, the tree's end), nobody applied it: the pause closes *not taken*, the answer and who gave
  it stay in the audit trail, and the channel's optional `onPauseAnswerNotTaken(event)` is told
  ([Telling the channel and the listeners](#telling-the-channel-and-the-listeners-940)). Another answer
  to such a pause is refused `answered`: one answer was recorded already.
- **After the retention** (`retention.pauseRecords`, 24 h) the record is gone and the id is unknown:
  `PauseError.UnknownPause`. Over [A2A](A2A) a late follow-up is `-32004` with `a2a.pause-closed`.

## Concurrent answers

A resume has two phases (Q58): **1. record the decision** — after the credential check and the
validation, the root's record of a resting tree is made `running`, then the pause goes from
`Pending` to `Resolved` atomically; a second resume of the same `pauseId` gets `PauseError.Closed` and
moves nothing. A resume whose process dies after phase 1 leaves a `running` root: recovery
([Several instances](Several-instances#recovery)) takes its lease and continues it with the recorded
decision, once (#850). **2. move the tree** — the call takes the tree's
lease ([Several instances](Several-instances#the-execution-lease)) and continues with **every**
resolved pause of the tree in one pass (one LangGraph `Command({ resume })` mapping each pause's
interrupt id); before it lets the tree rest paused it takes the pauses resolved meanwhile (the
drain), so no recorded decision waits for another webhook. A call that finds the lease held waits
until the holder ends its pass and returns the tree's current `ExecutionOutput`, its decision taken;
if the holder's lease expires meanwhile, the waiting call takes it and goes on. A reply that lands
while the channel's `send` is still returning (a fast webhook) is taken by the step at once — the
call does not pause at all.

A tree whose holder died with nobody waiting is picked up by the
[recovery](Several-instances#recovery) of interrupted executions, which takes the resolved pauses
first.

## Testing

`app.resume(…)` in a test answers like a webhook: a `ThreadOwner` pause by
`result.pending[0].pauseId`, a `Channel` pause by the `pauseId` your test implementation of the target
was sent. `AutoApproveChannel` / `AutoRejectChannel` named on a tool decide at once (no pause), and
`mockService(Implementation).send.mockResolvedValue(ChannelOutcome.decided({ approved: true }))` scripts a
role's implementation ([Testing](Testing)). `testWith(App, { instances: 2 })` answers two pauses of
one tree from two instances at once. A model reply interpreter is scripted by what it reads —
`mockModel(RefundReplyInterpreter).when({ reply: "ok, but only half" }).thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true, … }))`,
one on a decision model by its yes / no — `mockModel(DepositReplyInterpreter).thenReturn(decideWith({ approved: 0.9 }))`
(#267 S124) — and a code one replaced with
`mockService(Interpreter).interpret.mockReturnValue(ChannelInterpretation.understood({ approved: true }))`
(`mockModel` of a code interpreter is a setup error: it calls no model). Retention is tested with `clock.advance(…)`: the sweep runs on the
test's clock.

## Not yet

An agent asking an external task as one of its tools is #712. Choosing a channel implementation per environment (a terminal in dev, Slack in prod) is a
documented limit: one implementation per application.
