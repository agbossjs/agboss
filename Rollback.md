# Rollback — declared compensation

A step that changes the world (reserves stock, charges a card, books a slot) may have to be undone
when a later step fails. The undo is an ordinary `@Action`, and the action that needs it says so:
`@Action({ compensateWith: ReleaseStockAction })` (#339,
[ADR-0020](ADR-0020-Declared-compensation)). Where a path can say what happens after a failure —
an `.onError(ErrorClass, <side path>)` right after the step that throws, or a join's
`.onJoinError(…)` — the side path runs the undo actions itself, newest first, and `agboss check`
proves it does. Where no path can say it — a cancel, an uncaught failure or limit, a failed join's
finished branches — the framework will run them (#340).

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
  (`[flow.committer-unreachable]`, an error under `--strict`).

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

## Explicit where a path can say it, automatic where none can

A side path is where a failure is handled: writing the undo there keeps it reviewed, typed (the
undo reads what its action returned) and tested like the rest of the flow, and the declaration
lets `agboss check` prove no side path forgets it. Some stops have no path to write: a cancel, an
uncaught step failure or limit, an aborted child workflow, and the finished branches of a failed
join, whose values never reach the side path. There — and only there — the framework runs the open
actions' undo actions itself, newest first, each with its own idempotency key and a bounded
clean-up signal; a failing undo does not stop the others, and the execution fails with
`CompensationFailedError`. That automatic part comes with #340; until then such a stop leaves the
actions as they are, as before.
