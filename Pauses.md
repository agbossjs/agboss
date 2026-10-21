# Pauses

A tool that needs a decision names a channel ([Tools → Approval channels](Tools#approval-channels));
when its channel answers `ChannelOutcome.awaitReply()` the call **pauses** until someone answers it.
An execution may wait for **several answers at once** — parallel branches each pause on their own —
and each pause is answered **by its id** (#267). How a pause maps onto LangGraph and the agent's
loop: [Pause seam](Pause-seam).

## A pause stops only those who cannot go on without it

A paused branch of a [parallel launch](Parallel) does not stop its siblings: they run to their end
in the same pass (a paused branch frees its `maxConcurrency` slot), and the execution rests only
when nothing else can move — the join waits only for the paused ones. `result.pending` lists every
waiting pause, one `PendingPause` each:

| Field              | What it is                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- |
| `pauseId`          | what `app.resume` takes — only for a `PauseAnswerer.ThreadOwner` pause (below)         |
| `answeredBy`       | who may answer it: `PauseAnswerer.ThreadOwner` or `PauseAnswerer.Channel` (its role's) |
| `agent`, `channel` | whose tool call waits, and the channel asked (a role's name or a `@Channel`'s)         |
| `itemIndex`        | the item of a per-item launch it waits in — no copy of the item                        |
| `childExecutionId` | the child execution it waits in ([Workflow as a step](Workflow-as-a-step#at-run-time)); `undefined` in the root |
| `ask`              | the question: the tool call (`ToolCallApprovalAskDto`), `sensitive` fields masked      |

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
import type { App } from "agboss";
declare const app: App;
declare const replyKey: string;
-->

```ts
// a Slack webhook: the finance manager pressed "Approve"; the message's reply key is the pauseId
const result = await app.resume(
  { pauseId: replyKey, decision: { approved: true } },
  { tenantId: "acme", answeredBy: "manager-17" },
);
console.log(result.threadId, result.runId, result.pending.length);
```

- **By its id, always** — one way, also when there is only one pause, and without a `threadId`: the
  pause is found by `(tenantId, pauseId)` anywhere in the execution tree (a parallel branch, a child
  at any depth) and the runtime wakes the chain up to the root. An unknown id, or another tenant's,
  is the same `UnknownPauseError` (`pause.unknown`), with no hint that the id exists elsewhere.
- **The rest keep waiting**: with other pauses left the execution pauses again with them
  (`status: Paused`, the rest in `pending`); the last answer lets it go on to its finish. The result
  carries `threadId` and `runId`, so a webhook that needs them gets them back.
- **The decision is validated before it is recorded**: a `ToolCallApprovalDecisionDto` —
  `approved`, `reason?`, `overrideArguments?` (only with `approved: true`, and a valid input of the
  tool) — else `DtoValidationError` and the pause keeps waiting. The same check applies to a
  channel's `ChannelOutcome.decided(…)` (the step fails). Approved → the tool runs once (with the
  `overrideArguments`, if given); rejected → the model reads `Tool error: the call was rejected by
  <who answered>[: <reason>]`.
- `app.cancel(threadId)` stays by thread — a conversation is cancelled, not a pause: its pauses are
  withdrawn.

## Answering with free text: `app.resume({ pauseId, reply }, options)`

A webhook that only has the person's words — a Slack thread reply, a mail — passes them as they
are; the pause's role reads them with its **reply interpreter** (#267 PR 3), named on the role:

<!-- snippet-context
import { ChannelOf, ChannelRole, DecidedBy, PauseAnswerer, ReplyInterpreter, type App } from "agboss";
import { Integer, Text } from "agboss/dto";
declare const app: App;
declare const replyKey: string;
export class RefundCardInputDto {
  @Text() orderId!: string;
  @Integer() amountCents!: number;
}
-->

```ts
@ReplyInterpreter({
  name: "refund-reply-interpreter",
  description: "Turns a manager's free-text reply into a refund decision",
  decidedBy: DecidedBy.Model,
  model: "moonshotai/kimi-k2.6",
  prompt:
    "The manager answered a refund approval in free text. Decide approve / reject and any changed amount.",
})
export class RefundReplyInterpreter {}

@ChannelRole({
  name: "refund-approval-channel",
  description: "Approves card refunds",
  approves: RefundCardInputDto,
  answeredBy: PauseAnswerer.Channel,
  replyInterpreter: RefundReplyInterpreter, // one interpreter belongs to one role
})
export abstract class RefundApprovalChannel extends ChannelOf<RefundApprovalChannel> {}

// the webhook passes the text as it came; the result is the same as with a decision
await app.resume({ pauseId: replyKey, reply: "ok, but only half" }, { answeredBy: "manager-17" });
```

- **Exactly one of `decision` or `reply`** — by types (`ResumeRequest = DecisionResumeRequest |
  ReplyResumeRequest`) and at run time: both, or an empty `reply`, is `DtoValidationError` before the
  pause is looked up. The credential (`ownerId` / `answeredBy`) is checked as for a decision.
- **The interpreter gets the pause's original question and the reply** — `{ ask, reply }`, where the
  amount to halve is in `ask.arguments` — and what it gives is validated like a decision (the role's
  answer DTO: `ToolCallApprovalDecisionDto` for an `approves` role, `overrideArguments` checked by
  the tool's input). Code downstream decides by types, never by the text.
- **`DecidedBy.Model`** — a chat model answers through one answer tool of the role's answer DTO; its
  static `prompt` / `promptUrls` are its instructions, the question and the reply come in the input
  message (`### ask` / `### reply`, #270 Q51). **For an approval role the model may be a decision
  model** (Jev, #267 S124 a): it reads approve / refuse only — one `Decision.noul("approved")` about
  the question and the reply (the same input message, as the decision's state), the interpreter's
  `prompt` after the framework's question as its instructions; approved when P(yes) > 0.5, the
  answer `{ approved }` — never a `reason` or `overrideArguments`. A question role (`ask` + `answer`)
  on a decision model is `[reply-interpreter.decision-model]` at assembly: its answer needs more than
  a yes / no can give (the message names the answer DTO). Either model's call goes through the provider its model
  resolves to by `serves` (`[model.unserved]` like any model), is checked against the tree's budgets
  before it is made (an exhausted one → `BudgetExceededError`, the pause untouched), is counted in
  their ledger at once and in the execution's `spend` when the step takes the answer — once — and is
  traced under the pause's execution (cost caller `reply-interpreter:<name>`). Its model reads the
  question and the reply through the application's and the workflow's PII policies (#120), like an
  agent's: a `replaceWithToken()` value is a token for the model, its answer is revealed before it is
  validated (the tool gets the real value), a token no map knows is a decline (the pause stays
  `Pending`), a `blockWithRefusal` value in them throws `PiiRefusedError`.
- **`DecidedBy.Code`** — `implements ReplyInterpreterHandler<Self>`: `interpret(input:
  InputOf<Self>)` returns its outcome (#267 S124 b), sync or as a promise —
  `ReplyInterpretation.understood(decision)` (`OutputOf<Self>`, validated like any decision) or
  `ReplyInterpretation.notUnderstood({ reason })` for a reply it cannot read; a plain object does not
  compile (the pattern of `ChannelOutcome` and `JudgeVerdict`). Typed by the generated
  `.agboss/types.d.ts`; `deps` like any component, created by the application's container. A `throw`
  is for an unexpected crash only: it is unreadable too, the thrown error its `cause`.
- **Either kind reads in the pause's execution frame**: an injected `ExecutionContext` reads the
  pause's execution — its `tenant`, `ownerId`, the execution's own fields — and the waiting step
  (`step.nodeId`, `step.callId`, its idempotency key), so the provider's rate limits see the tenant.
- **The pause survives a bad reply**: interpretation runs before the pause is closed. A reply that
  cannot be read as a valid answer — a code interpreter's `notUnderstood`, a model that gave no
  answer, an answer invalid for the role, an interpreter that crashed — throws
  `UninterpretableReplyError` (`pause.uninterpretable-reply`; `reason` — the interpreter's own, or
  the error's message — and `cause` when an error is behind it), and the pause stays `Pending`: ask
  for a clearer answer, or answer with a `decision`. A `reply` for a role without `replyInterpreter` is
  `ReplyInterpreterMissingError` (`pause.no-reply-interpreter`), the pause untouched.
- Assembly checks, all at once with the channel rules: `[name.kind-suffix]` (`-reply-interpreter`),
  `[reply-interpreter.not-an-interpreter]` (a `replyInterpreter` class without `@ReplyInterpreter`),
  `[reply-interpreter.no-interpret-method]`, `[channel.shared-interpreter]` (one class in two roles).

Both new forms side by side — a decision model for a deposit return, and an owner's buttons read by
code:

<!-- snippet-context
import { Agent, Channel, ChannelOf, ChannelOutcome, ChannelRole, DecidedBy, Injectable, PauseAnswerer, ReplyInterpretation, ReplyInterpreter, Tool, Workflow, WorkflowFinish, WorkflowStart, start, type ChannelAsk, type InputOf, type OutputOf, type ReplyInterpreterHandler, type ToolHandler } from "agboss";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";

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
// approve / refuse on a decision model: one Decision.noul("approved"), no reason, no overrideArguments
@ReplyInterpreter({
  name: "deposit-reply-interpreter",
  description: "Reads whether a clerk's reply approves a deposit return",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "The clerk answered a deposit return.",
})
export class DepositReplyInterpreter {}

@ChannelRole({
  name: "deposit-approval-channel",
  description: "A clerk approves deposit returns",
  approves: DepositReturnDto, // an approval role: a decision model may read its replies
  answeredBy: PauseAnswerer.Channel,
  replyInterpreter: DepositReplyInterpreter,
})
export abstract class DepositApprovalChannel extends ChannelOf<DepositApprovalChannel> {}

// by code: the chat app sends a button's value back — {"approved":true}; anything else is not understood
@ReplyInterpreter({
  name: "expense-reply-interpreter",
  description: "Reads an expense button's value",
  decidedBy: DecidedBy.Code,
})
export class ExpenseReplyInterpreter implements ReplyInterpreterHandler<ExpenseReplyInterpreter> {
  interpret(
    input: InputOf<ExpenseReplyInterpreter>,
  ): ReplyInterpretation<OutputOf<ExpenseReplyInterpreter>> {
    const value: unknown = JSON.parse(input.reply); // a text that is no JSON: a crash
    if (typeof value !== "object" || value === null || !("approved" in value))
      return ReplyInterpretation.notUnderstood({ reason: `not an expense button: ${input.reply}` });
    return ReplyInterpretation.understood({ approved: value.approved === true });
  }
}

@ChannelRole({
  name: "expense-approval-channel",
  description: "The thread's owner confirms an expense with two buttons",
  approves: ExpenseDto,
  answeredBy: PauseAnswerer.ThreadOwner,
  replyInterpreter: ExpenseReplyInterpreter,
})
export abstract class ExpenseApprovalChannel extends ChannelOf<ExpenseApprovalChannel> {}

@Channel({ name: "desk-deposit-approval-channel", description: "Asks the clerk on duty" })
export class DeskDepositApprovalChannel extends DepositApprovalChannel {
  send(_ask: ChannelAsk<DepositApprovalChannel>): Promise<ChannelOutcome<DepositApprovalChannel>> {
    return Promise.resolve(ChannelOutcome.awaitReply()); // posts the question, keyed by pauseId
  }
}

@Channel({ name: "button-expense-approval-channel", description: "Shows the owner two buttons" })
export class ButtonExpenseApprovalChannel extends ExpenseApprovalChannel {
  send(_ask: ChannelAsk<ExpenseApprovalChannel>): Promise<ChannelOutcome<ExpenseApprovalChannel>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "return_deposit",
  description: "Returns a deposit",
  input: DepositReturnDto,
  output: DeskDoneDto,
  channel: DepositApprovalChannel,
})
export class ReturnDepositTool implements ToolHandler<DepositReturnDto, DeskDoneDto> {
  run({ leaseId }: DepositReturnDto): Promise<DeskDoneDto> {
    return Promise.resolve({ status: `returned the deposit of ${leaseId}` });
  }
}

@Tool({
  name: "book_expense",
  description: "Books an expense",
  input: ExpenseDto,
  output: DeskDoneDto,
  channel: ExpenseApprovalChannel,
})
export class BookExpenseTool implements ToolHandler<ExpenseDto, DeskDoneDto> {
  run({ purpose }: ExpenseDto): Promise<DeskDoneDto> {
    return Promise.resolve({ status: `booked ${purpose}` });
  }
}

@Agent({
  name: "office-agent",
  description: "Returns deposits and books expenses",
  prompt: "Do what is asked.",
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
  flow: [
    start(OfficeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OfficeAgent)
      .toFinish(OfficeWorkflowFinish),
  ],
})
export class OfficeWorkflow {}
```

## Who may answer

`@ChannelRole({ …, answeredBy })` is required (no default): a forgotten value must not let a customer
approve their own refund.

| `answeredBy`                 | `resume` takes                                    | Its `pauseId`                                       |
| ---------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `PauseAnswerer.ThreadOwner`  | the thread's `ownerId` (another → `ThreadOwnerError`) | listed in `result.pending`                      |
| `PauseAnswerer.Channel`      | `answeredBy: "manager-17"` — non-empty            | only in the channel's `ask.pauseId`                 |

The channel's side authenticates who answers a `Channel` pause (Slack, a ticket system, an admin
panel already knows the manager); the framework adds no permission model of its own — it checks that
`answeredBy` is given and records it on the pause and in `onExecutionResume` (`event.answeredBy`).
**`pauseId` is the right to answer**: a cryptographically random 128-bit token made once per pause,
before the first `send` — a retried `send` gets the same one, so it is safe as the idempotency key
towards Slack, mail or a ticket system — and `result.pending` and `onExecutionPause` leave it out of a
`Channel` pause, so the token never leaves the channel's server side. A `ThreadOwner` pause answered
with `answeredBy`, or a `Channel` pause with `ownerId` (or without `answeredBy`), is
`PauseAnswererError` (`pause.wrong-answerer`); the pause keeps waiting. A concrete `@Channel` a tool
names as is (`TerminalUserChannel`) is answered by the thread's owner. The resumed pass runs as the
thread's owner (`executionContext.ownerId`), whoever answered.

## A pause's life

Every pause is a record of the application's `PausedExecutionRepository`
([App → infrastructure](App), its SQLite implementation `SqlitePausedExecutionRepository`), keyed
by the waiting step's idempotency key, so a step re-entered — after a sibling's answer, or a retry
after a crash — finds the same `pauseId`:

| `PauseStatus` | Means                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| `Pending`     | waiting; `isSent` once its channel's `send` returned                                     |
| `Resolved`    | a resume recorded its decision (atomically, from `Pending` only); the holder takes it    |
| `Taken`       | its step took the decision and went on — or its channel decided at once                  |
| `Cancelled`   | withdrawn: a sibling failed under `FailFast`, the thread was cancelled, or the tree ended |

An answer to anything but `Pending` → `NotPausedError` (`run.not-paused`): a double click, a late
answer to a withdrawn question. Each record also says how it was resolved (`PauseResolution`), with
its answer (`answer: PauseAnswer` — the decision, who answered, what reading a reply cost) and when
(`askedAt`, `resolvedAt`, on the application's `Clock`):

| `PauseResolution` | How                                                                   | Status      |
| ----------------- | --------------------------------------------------------------------- | ----------- |
| `Decided`         | its channel answered `ChannelOutcome.decided(…)` — the call never paused | `Taken`  |
| `Replied`         | `awaitReply()`, then `app.resume` (a `decision` or a `reply`)          | `Resolved` → `Taken` |
| `Withdrawn`       | a `FailFast` sibling failed before an answer                           | `Cancelled` |
| `Cancelled`       | `app.cancel`, or its tree ended before an answer                       | `Cancelled` |

**Retention** (#267 S107): a resolved record (`Taken`, `Cancelled`) is kept
`@Application({ pauseRecordRetention })` after it was resolved — default `hours(24)` — and then
removed by the [recovery sweep](Several-instances#recovery) (every 30 s, on the `Clock`) through
`PausedExecutionRepository.deleteResolvedBefore(cutoff)`. Within the window a late answer gets
`NotPausedError`; after it the id is unknown — `UnknownPauseError`. A `Pending` pause (and a
`Resolved` one no pass took yet) is never removed, however old.

## Who answered: `result.record.pauses`

`{ record: true }` on `execute` / `resume` returns the execution record
([Observability → the execution record](Observability)); its `pauses` are the audit trail — every
resolved pause of the tree, in the order they were asked:

| Field                    | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `pauseId`                | its id — `undefined` for a `PauseAnswerer.Channel` pause (only its channel has it) |
| `executionId`            | the execution it waited in: the root's, or a child's (#267 S124)               |
| `step`                   | the waiting step: agent, node, visit, copy, item, tool call (`StepRecord`)     |
| `role`, `answeredBy`     | the channel asked and who may answer                                           |
| `responder`              | the `ownerId` / `answeredBy` of `app.resume`; `undefined` when decided at once, withdrawn or cancelled |
| `resolution`             | `PauseResolution`                                                              |
| `askedAt`, `resolvedAt`  | ISO 8601, the application's `Clock`                                            |
| `decision`               | what was decided, masked by the application's PII policies; `undefined` when withdrawn or cancelled |

The list is the permanent history: each entry is written when its pause is resolved — answered,
decided at once, withdrawn or cancelled — into the execution records
(`ExecutionRecordRepository.savePauseAnswer(tenantId, rootExecutionId, answer)`, once per pause), and
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
siblings' pauses are withdrawn — the tree goes on to the join (its `.onJoinError(…)`, else the
execution fails with the branch's error) instead of waiting for answers nobody needs. The join
runs in the pass that takes the withdrawal, and it still gets the error object the branch threw:
`.onJoinError(E, …)` matches by class and cause chain as always — `.onJoinError(PaymentDeclinedError,
…)` and `.onJoinError(StepFailedError, …)` both take an agent that failed with a domain error, and
without a handler the execution rejects with that same `AgentFailedError`. A channel whose `send`
throws (not cancelled) fails the asking agent's step: `AgentFailedError`, the channel's error as its
`cause` — never a tool error the model reads. A join's
`deadline` counts elapsed time on the application's `Clock`, pauses included ([Parallel](Parallel)).

## Concurrent answers

A resume has two phases (Q58): **1. record the decision** — after the credential check and the
validation, the pause goes from `Pending` to `Resolved` atomically; a second resume of the same
`pauseId` gets `NotPausedError` and moves nothing. **2. move the tree** — the call takes the tree's
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
`result.pending[0].pauseId`, a `Channel` pause by the `pauseId` your test implementation of the role
was sent. `AutoApproveChannel` / `AutoRejectChannel` named on a tool decide at once (no pause), and
`mockOf(Implementation).send.mockResolvedValue(ChannelOutcome.decided({ approved: true }))` scripts a
role's implementation ([Testing](Testing)). `testWith(App, { instances: 2 })` answers two pauses of
one tree from two instances at once. A model reply interpreter is scripted by what it reads —
`mockLlm(RefundReplyInterpreter).when({ reply: "ok, but only half" }).thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true, … }))`,
one on a decision model by its yes / no — `mockLlm(DepositReplyInterpreter).thenReturn(decideWith({ approved: 0.9 }))`
(#267 S124) — and a code one replaced with
`mockOf(Interpreter).interpret.mockReturnValue(ReplyInterpretation.understood({ approved: true }))`
(`mockLlm` of a code interpreter is a setup error: it calls no model). Retention is tested with `clock.advance(…)`: the sweep runs on the
test's clock.

## Not yet

Choosing a channel implementation per environment (a terminal in dev, Slack in prod) is a
documented limit: one implementation per application.
