# Rollback — declared compensation

A step that changes the world (reserves stock, charges a card, books a slot) may have to be undone
when a later step fails. The undo is an ordinary `@Action`, and the action that needs it says so:
`@Action({ compensateWith: ReleaseStockAction })` (#339,
[ADR-0020](ADR-0020-Declared-compensation)). Where a path can say what happens after a failure —
an `.onError(ErrorClass, <side path>)` right after the step that throws, or a join's
`.onJoinError(…)` — the side path runs the undo actions itself, newest first, and `agboss check`
proves it does. Where no path can say it, the framework runs them itself: a failed join's finished
branches (#340 PR 2, below); a cancel, an uncaught failure or limit, an aborted child workflow
(#340 PR 3, [below](#an-execution-that-ends-without-a-finish)).

<!--
```ts file=order.components.ts
import { Action, WorkflowFinish, WorkflowStart, type ActionHandler, type FinishHandler, type InputOf, type OutputOf } from "agboss";
import { Text } from "agboss/dto";

export class OrderRequestDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}
export class StockReservationDto {
  @Text({ prompt: "the reservation id" })
  reservationId!: string;
}
export class PaymentDto {
  @Text({ prompt: "the payment id" })
  paymentId!: string;
}
export class OrderShippedDto {
  @Text({ prompt: "the tracking number" })
  trackingNumber!: string;
}
export class CarrierError extends Error {}
export class PaymentProviderError extends Error {}
@WorkflowStart({ name: "order-workflow-start", description: "An order to ship", input: OrderRequestDto })
export class OrderWorkflowStart {}
@Action({ name: "release-stock-action", description: "Releases the reserved stock", input: { reservation: StockReservationDto } })
export class ReleaseStockAction implements ActionHandler<ReleaseStockAction> {
  async execute(input: InputOf<ReleaseStockAction>): Promise<void> {
    await Promise.resolve(input.reservation.value.reservationId);
  }
}
@Action({ name: "refund-card-action", description: "Refunds the card", input: { payment: PaymentDto } })
export class RefundCardAction implements ActionHandler<RefundCardAction> {
  async execute(input: InputOf<RefundCardAction>): Promise<void> {
    await Promise.resolve(input.payment.value.paymentId);
  }
}
@Action({ name: "reserve-stock-action", description: "Reserves the stock", input: { order: OrderRequestDto }, output: StockReservationDto, compensateWith: ReleaseStockAction })
export class ReserveStockAction implements ActionHandler<ReserveStockAction> {
  execute(input: InputOf<ReserveStockAction>): Promise<OutputOf<ReserveStockAction>> {
    return Promise.resolve({ reservationId: `reservation-${input.order.value.orderId}` });
  }
}
@Action({ name: "charge-card-action", description: "Charges the card", input: { order: OrderRequestDto }, output: PaymentDto, compensateWith: RefundCardAction })
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    return Promise.resolve({ paymentId: `payment-${input.order.value.orderId}` });
  }
}
@Action({ name: "ship-order-action", description: "Hands the order to the carrier", input: { order: OrderRequestDto }, output: OrderShippedDto })
export class ShipOrderAction implements ActionHandler<ShipOrderAction> {
  execute(input: InputOf<ShipOrderAction>): Promise<OutputOf<ShipOrderAction>> {
    return Promise.resolve({ trackingNumber: `track-${input.order.value.orderId}` });
  }
}
@Action({ name: "notify-finance-team-action", description: "Tells finance a refund failed", input: { order: OrderRequestDto } })
export class NotifyFinanceTeamAction implements ActionHandler<NotifyFinanceTeamAction> {
  async execute(input: InputOf<NotifyFinanceTeamAction>): Promise<void> {
    await Promise.resolve(input.order.value.orderId);
  }
}
@WorkflowFinish({ name: "order-failed-workflow-finish", description: "The order could not be shipped", output: OrderRequestDto })
export class OrderFailedWorkflowFinish {}
@WorkflowFinish({ name: "order-workflow-finish", description: "The shipped order", input: { shipped: OrderShippedDto }, output: OrderShippedDto })
export class OrderWorkflowFinish implements FinishHandler<OrderWorkflowFinish> {
  finish(input: InputOf<OrderWorkflowFinish>): OutputOf<OrderWorkflowFinish> {
    return { trackingNumber: input.shipped.value.trackingNumber };
  }
}
```
-->

## The pattern

<!-- snippet-context
import { Workflow, action, start, toAction } from "agboss";
import { CarrierError, ChargeCardAction, NotifyFinanceTeamAction, OrderFailedWorkflowFinish, OrderRequestDto, OrderShippedDto, OrderWorkflowFinish, OrderWorkflowStart, PaymentDto, PaymentProviderError, RefundCardAction, ReleaseStockAction, ReserveStockAction, ShipOrderAction, StockReservationDto } from "./order.components.js";
-->

```ts
// ReserveStockAction { compensateWith: ReleaseStockAction }, ChargeCardAction { compensateWith: RefundCardAction }
@Workflow({
  name: "order-workflow",
  version: "1.0.0",
  flow: [
    start(OrderWorkflowStart)
      .returns(OrderRequestDto)
      .toAction(ReserveStockAction)
      .returns(StockReservationDto) // data: ReleaseStockAction reads its reservationId
      .toAction(ChargeCardAction)
      .returns(PaymentDto) // RefundCardAction reads its paymentId
      .toAction(ShipOrderAction)
      .onError(
        CarrierError, // the carrier failed: undo what was done, newest first — checked
        toAction(RefundCardAction) // side effects without output: no .returns
          .onError(
            PaymentProviderError, // the refund failed: a person takes over; the stock still goes back
            toAction(NotifyFinanceTeamAction)
              .toAction(ReleaseStockAction),
          )
          .toAction(ReleaseStockAction),
      )
      .returns(OrderShippedDto)
      .toFinish(OrderWorkflowFinish), // a finish commits what is still open

    action(ReleaseStockAction) // reached from two places: its own path
      .toFinish(OrderFailedWorkflowFinish),
  ],
})
export class OrderWorkflow {}
```

## How `.onError` behaves

- It stands **right after the step that throws** (an agent, an action, a router), before that
  step's `.returns(…)`, or right after the source of an own path
  (`agent(X).onError(E, …).returns(oneOf(…)).switch(…)`). It catches that step's own failure only, never the next
  step's; the main path continues after it.
- A step may have several; the most specific class wins, matched by class through the error's
  cause chain — a subclass is caught by its parent's handler, and so is an error caused by it
  (`ActionFailedError` wraps what an action throws, the original in `cause`). Two handlers for one
  class on one step fail assembly (`[flow.duplicate-error-handler]`). Without a handler the
  execution fails.
- The side path is a path like any other: `toAction(…)` / `toAgent(…)` continued to a finish, or
  `toFinish(F)` alone; it may have its own `.onError(…)` for a failed undo.
- The failure is a plain record in state (`lastError`: its codes, message, the failed node), so a
  handler holds after a resume. The visited path shows the failed step before the side path.
- Limits are errors too: `.onError(VisitsLimitExceededError, …)` after a node with `maxVisits`,
  `.onError(LimitExceededError, …)` for any limit.

## What `agboss check` proves

- `compensateWith` and `committedBy` name `@Action` classes — an undo is code, never a model call
  (`[action.compensator-not-an-action]`, `[action.committer-not-an-action]`); an action does not
  undo itself (`[action.self-compensation]`), and an undo action is not undone
  (`[action.compensator-compensates]`, no chains).
- The undo reads only what the path holds **right after** its action — what reached the action and
  what it returned, on every path (`[action.invalid-compensator-input]`): `ReleaseStockAction`
  reads the `StockReservationDto` its action returned.
- A side path entered after an undoable action succeeded — `.onError` of a later step, or
  `.onJoinError` of a later launch — reaches a finish only through its undo action
  (`[flow.uncompensated-action]`), and runs several undo actions newest first
  (`[flow.compensation-out-of-order]`). An undo whose own `.onError` takes over still counts as run.
  A failed join's side path owes what was open before the launch; the launch's finished branches are
  undone by the framework (#340).
- `committedBy: ConfirmOfferAction` — once it succeeds, nothing undoes the action any more: a side
  path after it owes nothing for it. Every path from the action then runs the committer or the undo
  before a finish (`[flow.uncommitted-action]`, an error — leave `committedBy` out and a finish
  commits it); a committer no path from the action reaches is a warning
  (`[flow.committer-unreachable]`, an error under `--strict`). `committedBy` without
  `compensateWith` has no effect — nothing undoes the action, so nothing commits it — and is an
  error (`[action.committer-without-compensator]`): add `compensateWith`, or remove `committedBy`.

Without `RefundCardAction` on the side path above, the check names it:

```
[flow.uncompensated-action] order-workflow: the .onError(CarrierError, …) side path after
ship-order-action reaches order-failed-workflow-finish without refund-card-action (compensates
charge-card-action); add it to the side path, or commit the action before it
```

`agboss describe` prints each undoable action (`--json`: its node's `action`,
[CLI](CLI#the-declarative-snapshot-268)):

```
actions
  charge-card-action  compensateWith refund-card-action
  reserve-stock-action  compensateWith release-stock-action
```

`examples/flow-patterns/src/hiring/` sends an offer this way: two undoable steps, both
`committedBy: ConfirmOfferAction`, and a letter whose failure undoes them.

## Records: what is open, committed, undone (#340)

At run time every undoable action that succeeds opens a record in the execution's state (the
`compensations` channel, checkpointed with it, and mirrored in process at once): its step and key,
its undo action, its committer, and a snapshot of what its undo reads — the undo's input fields as
the scope held them right after the action. A parallel branch's record opens when the branch ends.
A record is closed by

- its **committer** succeeding (`committedBy`): nothing undoes it any more;
- a **finish**, for a record without `committedBy` (with one, the rules close it first); a child
  workflow's finish commits the child's own records ([Workflow as a step](Workflow-as-a-step));
- its **undo action on a side path** — it closes the newest open record of the action it undoes:
  `CompensationReason.SidePath`, `CompensationStatus.Compensated`, or `Failed` (with its error) when
  the undo's own `.onError` took its failure. That undo keeps its own visit's key.

`result.compensations` (and `result.record.compensations`) list the undo actions that ran, in the
order they ended — `CompensationRecord { compensated, compensator, reason, status, error?,
startedAt, endedAt }`; a run that undid nothing has `[]`. Tests: `toHaveCompensated(Action, { by,
reason?, status? })` ([Testing](Testing)).

## A failed join undoes its finished branches

A join that fails drops its branches' values: an `.onJoinError` side path cannot undo a finished
sibling. So before that side path runs — or the branch's error fails the execution — the framework
undoes the launch's finished undoable branches itself (`CompensationReason.JoinFailed`), newest
first. It first awaits the launch's branches whose bodies still run, up to `compensationTimeout`;
one that returns meanwhile is undone too.

<!--
```ts file=trip.components.ts
import { Action, WorkflowFinish, WorkflowStart, type ActionHandler, type FinishHandler, type InputOf, type OutputOf } from "agboss";
import { Text } from "agboss/dto";

export class TripRequestDto {
  @Text({ prompt: "where the trip goes" })
  destination!: string;
}
export class FlightBookingDto {
  @Text({ prompt: "the flight booking's id" })
  bookingId!: string;
}
export class HotelBookingDto {
  @Text({ prompt: "the hotel booking's id" })
  bookingId!: string;
}
export class TripBookedDto {
  @Text({ prompt: "both ids" })
  summary!: string;
}
export class BookingFailedError extends Error {}
@WorkflowStart({ name: "trip-workflow-start", description: "A trip to book", input: TripRequestDto })
export class TripWorkflowStart {}
@Action({ name: "cancel-flight-action", description: "Cancels the flight", input: { flight: FlightBookingDto } })
export class CancelFlightAction implements ActionHandler<CancelFlightAction> {
  async execute(input: InputOf<CancelFlightAction>): Promise<void> {
    await Promise.resolve(input.flight.value.bookingId);
  }
}
@Action({ name: "cancel-hotel-action", description: "Cancels the hotel", input: { hotel: HotelBookingDto } })
export class CancelHotelAction implements ActionHandler<CancelHotelAction> {
  async execute(input: InputOf<CancelHotelAction>): Promise<void> {
    await Promise.resolve(input.hotel.value.bookingId);
  }
}
@Action({ name: "book-flight-action", description: "Books the flight", input: { request: TripRequestDto }, output: FlightBookingDto, compensateWith: CancelFlightAction })
export class BookFlightAction implements ActionHandler<BookFlightAction> {
  execute(input: InputOf<BookFlightAction>): Promise<OutputOf<BookFlightAction>> {
    return Promise.resolve({ bookingId: `flight-${input.request.value.destination}` });
  }
}
@Action({ name: "book-hotel-action", description: "Books the hotel", input: { request: TripRequestDto }, output: HotelBookingDto, compensateWith: CancelHotelAction })
export class BookHotelAction implements ActionHandler<BookHotelAction> {
  execute(input: InputOf<BookHotelAction>): Promise<OutputOf<BookHotelAction>> {
    return Promise.resolve({ bookingId: `hotel-${input.request.value.destination}` });
  }
}
@WorkflowFinish({ name: "trip-not-booked-workflow-finish", description: "Not booked", output: TripRequestDto })
export class TripNotBookedWorkflowFinish {}
@WorkflowFinish({ name: "trip-booked-workflow-finish", description: "Booked", input: { flight: FlightBookingDto, hotel: HotelBookingDto }, output: TripBookedDto })
export class TripBookedWorkflowFinish implements FinishHandler<TripBookedWorkflowFinish> {
  finish(input: InputOf<TripBookedWorkflowFinish>): OutputOf<TripBookedWorkflowFinish> {
    return { summary: `${input.flight.value.bookingId} + ${input.hotel.value.bookingId}` };
  }
}
```
-->

<!-- snippet-context
import { Workflow, start, toFinish } from "agboss";
import { BookFlightAction, BookHotelAction, BookingFailedError, FlightBookingDto, HotelBookingDto, TripBookedWorkflowFinish, TripNotBookedWorkflowFinish, TripRequestDto, TripWorkflowStart } from "./trip.components.js";
-->

```ts
// BookFlightAction { compensateWith: CancelFlightAction }, BookHotelAction { compensateWith: CancelHotelAction };
// neither has committedBy: the finish commits
@Workflow({
  name: "trip-workflow",
  version: "1.0.0",
  flow: [
    start(TripWorkflowStart)
      .returns(TripRequestDto)
      .toParallelActions(BookFlightAction, BookHotelAction)
      .join()
      .onJoinError(
        BookingFailedError, // the hotel failed: the finished flight is cancelled before this path runs
        toFinish(TripNotBookedWorkflowFinish),
      )
      .returns(FlightBookingDto)
      .returns(HotelBookingDto)
      .toFinish(TripBookedWorkflowFinish),
  ],
})
export class TripWorkflow {}
```

Each automatic undo runs in a frame of its own: its step is the undo action's, its
`executionContext.step.idempotencyKey` is the undone step's key + `:compensation`
(`execution-1:book-flight-action:1:compensation` — a second run of the same undo carries the same
key), `step.compensates` is the step it undoes, and its `executionContext.signal` is a clean-up
signal — not the execution's: it aborts after `@Application({ compensationTimeout })` (default
`seconds(15)`, [App](App)), when the instance loses the tree's lease or stops. It takes no tree or
instance slot and no budget refuses it; what its services cost (`SpendRecorder`) is the execution's
spend under `action:<undo name>` ([FinOps](FinOps)). `onCompensationStart` / `onCompensationEnd`
report each one ([Observability](Observability)).

An undo that fails does not stop the others; then the execution fails with
`CompensationFailedError` (`compensation.failed`): `failures` are the undo actions that threw,
`cause` the branch's error — `toFailWith(BookingFailedError)` still matches through it. No
`.onError` / `.onJoinError` takes it. `agboss describe` marks a launched undoable action:

```
actions
  book-flight-action  compensateWith cancel-flight-action  (on a failed join: automatic)
```

`examples/flow-patterns/src/travel/` books a trip this way.

## An execution that ends without a finish

An execution that stops before a finish — an uncaught step failure, an uncaught limit
(`BudgetExceededError`, `StepsLimitExceededError`, `VisitsLimitExceededError`), `app.cancel`, a
sibling's failure under `FailurePolicy.FailFast` — undoes its open undoable actions, newest first,
before it ends (#340 PR 3): `CompensationReason.ExecutionFailed` for a failure or a limit,
`ExecutionCancelled` for a cancel or a `FailFast` abort. Each undo runs as a failed join's does
(above): its own frame and key, the clean-up signal, no slot, no budget check. Where it happens:

- **A child workflow** undoes its own actions in its parent's step, before its error reaches the
  parent ([Workflow as a step](Workflow-as-a-step)); its finish commits them, so a finished child
  is never undone by a later failure of its parent.
- **A root** is undone by the instance that holds its lease, after its pass fails and before its
  record is failed, its keys are removed and `onExecutionError` is observed (whose `compensations`
  lists what ran, [Observability](Observability#automatic-undo)) — the actions of a paused child of
  it too, read from its checkpoint. The record is written **after** the undo (#340 S7): while it
  runs the root stays `running`, then its status and error are final (`CompensationFailedError`
  included).
- **`app.cancel` of a paused tree** takes its lease, withdraws its pauses (their channels are told,
  #337), undoes, and only then returns `{ cancelled: true }`
  ([Cancellation](Saga-And-Cancellation#global-cancellation)); a cancel from another instance
  (#360) of a running tree returns once it is recorded, and the holder undoes it.

LangGraph rejects an aborted pass before the step bodies still running return, and their writes
never reach the checkpoint, so the undo reads the records from the checkpoint (pending writes
applied) and from the instance's own registry, which every record reaches the moment its step
writes it. It first awaits the tree's running step bodies — children still undoing among them —
up to `compensationTimeout`: an action that returns meanwhile is undone too; one still running then
is logged (`compensation.step-still-running`) and, if it returns later, undone at once, in process
(its key `<step key>:compensation` makes a second run safe; a failure then is logged,
`compensation.late-undo-failed`). The undo's service spend goes to the ledger at once
([FinOps](FinOps)).

A failing undo does not stop the others; then the execution fails with `CompensationFailedError`,
its `cause` the original error (`toFailWith(StepFailedError)` still matches through it).
`CompensationFailedError` passes a child's boundary as it is — never wrapped in
`ChildExecutionFailedError`, like a cancel or an exhausted budget — so no `.onError` of the parent
takes it, and the parent, getting it uncaught, undoes its own open actions too. A cancel whose undo
failed still cancels the tree, but `app.cancel` of a paused tree **rejects** with the
`CompensationFailedError` (its `cause` the `ExecutionCancelledError`), and a running tree's holder's
`execute` / `resume` rejects with it (#340 S7).

**Durable (#340 PR 4).** An undo that an instance's stop, crash or lost lease interrupts is finished
by the instance that takes the tree over: before a root's undo starts the reserved tree key
`@agboss/unwinding` (`{ reason, cause }`) is written, and `@agboss/compensated/<compensationKey>`
after each undo that succeeds (a child's own undo marks `@agboss/unwinding:<childExecutionId>`).
Recovery finds the root still `running`, runs the remaining undos on its checkpoint state — the ones
marked done skipped — and ends it failed with the recorded reason, without a pass; a child
re-entered mid-undo finishes its own before any step and raises its error again
([Several instances → An undo interrupted mid-way](Several-instances#an-undo-interrupted-mid-way)).
A failed undo is not marked: the next holder runs it again (its key `<step key>:compensation`
makes that safe).

```ts no-check: the send-offer example's test (examples/flow-patterns/tests/hiring.test.ts), shown here as the case it proves
test("a cancel while paused: the pause is withdrawn, both undone, then cancelled", async ({ app, mockLlm, mockOf }) => {
  mockOf(AtsClientService).registerOffer.mockResolvedValue("offer-7");
  mockOf(HrCalendarService).bookSlot.mockResolvedValue("slot-3");
  mockLlm(OfferLetterAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada…" }));
  mockLlm(OfferSenderAgent).thenReturn(callTool(SendOfferLetterTool, { text: "Dear Ada…" }));
  const paused = await app.execute(SendOfferWorkflowStart, REQUEST, { threadId: "t-1" });

  const cancel = await app.cancel(paused.threadId); // waits for the undo, each bounded by compensationTimeout

  expect(cancel).toEqual({ cancelled: true });
  expect(mockOf(HrCalendarService).releaseSlot.mock.calls).toHaveLength(1);
  expect(mockOf(AtsClientService).withdrawOffer.mock.calls).toHaveLength(1);
});
```

## Explicit where a path can say it, automatic where none can

A side path is where a failure is handled: writing the undo there keeps it reviewed, typed (the
undo reads what its action returned) and tested like the rest of the flow, and the declaration
lets `agboss check` prove no side path forgets it. Some stops have no path to write: a cancel, an
uncaught step failure or limit, an aborted child workflow, and the finished branches of a failed
join, whose values never reach the side path. There — and only there — the framework runs the open
actions' undo actions itself, newest first, each with its own idempotency key and a bounded
clean-up signal; a failing undo does not stop the others, and the execution fails with
`CompensationFailedError`. A failed join's undo came with #340 PR 2, the undo of an execution that
ends without a finish — a cancel, an uncaught failure or limit, an aborted child — with #340 PR 3
([above](#an-execution-that-ends-without-a-finish)), and finishing an undo a stop, a crash or a
lost lease interrupted with #340 PR 4.
