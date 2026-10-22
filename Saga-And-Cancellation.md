# Cancellation and idempotency

Workflows that call external APIs (payments, bookings) need to **undo** what they already did when a
later step fails. There is no saga engine: an action declares its undo action
(`@Action({ compensateWith, committedBy })`, #339), and a side path after a failure runs it, newest
first — checked by `agboss check`, see [Rollback](Rollback) and
[ADR-0020](ADR-0020-Declared-compensation). Where no path can say it (a cancel, an uncaught
failure or limit, an aborted child, a failed join's finished branches) the framework undoes by
itself, newest first (#340, [Rollback](Rollback#an-execution-that-ends-without-a-finish)); the side
effects of an agent's tool calls are not undone. The explicit form:

```ts no-check: the pattern only — the full, compiled example is on the Rollback page
start(OrderWorkflowStart)
  .returns(OrderRequestDto)
  .toAction(ChargeCardAction)
  .returns(PaymentDto)
  .toAction(BookHotelAction)
  .onError(HotelUnavailableError, toAction(RefundPaymentAction).toFinish(NotBookedWorkflowFinish))
  .returns(BookingDto)
  .toFinish(BookedWorkflowFinish),
```

## Global cancellation

`app.cancel(threadId)` stops a running run **softly**: the run stops before its next model or tool call
and `execute` rejects with `ExecutionCancelledError` (`execution.cancelled`). A paused run is dropped
instead (its `resume` then throws `NotPausedError`). `{ cancelled }` is `false` when the thread had
neither.

**The undo on cancel (#340 PR 3).** A cancelled execution's open undoable actions
(`@Action({ compensateWith })` not yet committed or undone) are undone, newest first, before it
ends (`CompensationReason.ExecutionCancelled`). A running one rejects with `ExecutionCancelledError`
once its holder has undone them (`app.cancel` itself returns at once). A paused one is cancelled
under its lease: its pauses are withdrawn first (their channels told, #337), then the undo runs —
each undo action bounded by `compensationTimeout` — and `app.cancel` returns `{ cancelled: true }`
only after it; a paused child's actions are undone with its parent's. An undo that fails does not
stop the others (#340 S7): when `app.cancel` runs the undo itself — a paused tree, where
`{ cancelled: true }` means every undo succeeded — it **rejects with `CompensationFailedError`**
(its `cause` the `ExecutionCancelledError`; the tree is cancelled all the same, its record failed
with that error and `onExecutionError` given it); when it only aborts or requests the stop of a
running pass, the holder's `app.execute` / `app.resume` rejects with it. Committed actions and
actions a side path already undid are left as they are. While the undo runs the execution's record
stays `running`: an instance that stops or crashes mid-undo leaves the rest to another instance,
which finishes it — the undos done are not run again
([Several instances → An undo interrupted mid-way](Several-instances#an-undo-interrupted-mid-way)).

Any instance of the application may take the cancel (#360): one that does not run the execution
leaves a cancel request in the shared stores, and the instance that runs it stops it within one
lease renewal (10 s, or at its next checkpoint write) the same way; a request made while that
instance is down ends the execution at recovery instead of continuing it
([Several instances → Cancelling from any instance](Several-instances#cancelling-from-any-instance)).

<!-- snippet-context
import type { App } from "agboss";
declare const app: App;
declare const threadId: string;
declare const userId: string;
-->

```ts
// e.g. in the API handler of a "Cancel" button
const { cancelled } = await app.cancel(threadId, { ownerId: userId });
```

The caller's own `signal` (`execute(…, { signal })`) aborts the same way; tools and actions see
both as `executionContext.signal` (`deps: [ExecutionContext]`,
[Context and Authorization](Context-And-Authorization)). What a cancelled run already did stays
done: undo it from the caller, or in the next run.

## Idempotency

Undo actions — and any side effect — must be idempotent: a step interrupted by a crash may run
again. Every step has one key, `executionContext.step.idempotencyKey`
(`${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, #280): a tool call's ends
with its call id, every pass of a cycle has its own, and a retry or a resume keeps it. Pass it to
the external API (most payment APIs accept an idempotency key) and duplicates are filtered there.

<!--
```ts file=refund.workflow.ts
import { Action, Workflow, WorkflowFinish, WorkflowStart, start, type ActionHandler, type InputOf } from "agboss";
import { Text } from "agboss/dto";
export class PaymentDto {
  @Text({ prompt: "the payment id" })
  paymentId!: string;
}
@WorkflowStart({ name: "refund-workflow-start", description: "A payment to refund", input: PaymentDto })
export class RefundWorkflowStart {}
@WorkflowFinish({ name: "refunded-workflow-finish", description: "Refunded", output: PaymentDto })
export class RefundedWorkflowFinish {}
```
-->

<!-- snippet-context
import { Action, ExecutionContext, Workflow, start, type ActionHandler, type InputOf } from "agboss";
import { PaymentDto, RefundWorkflowStart, RefundedWorkflowFinish } from "./refund.workflow.js";
// @snippet
@Workflow({ name: "refund-workflow", version: "1.0.0", flow: [start(RefundWorkflowStart).returns(PaymentDto).toAction(RefundPaymentAction).toFinish(RefundedWorkflowFinish)] })
export class RefundWorkflow {}
-->

```ts
/** Refunds the payment; safe to run twice: its step's key is the same on a retry or a resume. */
@Action({
  name: "refund-payment-action",
  description: "Refunds the payment",
  input: { payment: PaymentDto },
  deps: [ExecutionContext],
})
export class RefundPaymentAction implements ActionHandler<RefundPaymentAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: InputOf<RefundPaymentAction>): Promise<void> {
    await fetch(`https://payments.example.com/refunds/${input.payment.value.paymentId}`, {
      method: "POST",
      headers: { "Idempotency-Key": this.executionContext.step.idempotencyKey },
    });
  }
}
```
