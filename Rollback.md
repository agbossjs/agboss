# Rollback — explicit error handling

A step that changes the world (reserves stock, charges a card, sends a message) cannot be undone by
the framework: it does not know what a tool call, a sent message or an MCP side effect did, and an
undo can itself fail. So there is **no automatic compensation** — no sagas, no `compensate`
metadata. A rollback is ordinary, explicit error handling in the path: `.onError(ErrorClass, <side
path>)` right after the step that throws, whose side path runs the undo actions and ends in a
finish (#272, [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)).

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
export class OrderShippedDto {
  @Text({ prompt: "the tracking number" })
  trackingNumber!: string;
}
export class CarrierError extends Error {}
export class PaymentProviderError extends Error {}
@WorkflowStart({ name: "order-workflow-start", description: "An order to ship", input: OrderRequestDto })
export class OrderWorkflowStart {}
@Action({ name: "reserve-stock-action", description: "Reserves the stock", input: { order: OrderRequestDto }, output: StockReservationDto })
export class ReserveStockAction implements ActionHandler<ReserveStockAction> {
  execute(input: InputOf<ReserveStockAction>): Promise<OutputOf<ReserveStockAction>> {
    return Promise.resolve({ reservationId: `reservation-${input.order.value.orderId}` });
  }
}
@Action({ name: "ship-order-action", description: "Hands the order to the carrier", input: { order: OrderRequestDto }, output: OrderShippedDto })
export class ShipOrderAction implements ActionHandler<ShipOrderAction> {
  execute(input: InputOf<ShipOrderAction>): Promise<OutputOf<ShipOrderAction>> {
    return Promise.resolve({ trackingNumber: `track-${input.order.value.orderId}` });
  }
}
@Action({ name: "refund-card-action", description: "Refunds the card", input: { order: OrderRequestDto } })
export class RefundCardAction implements ActionHandler<RefundCardAction> {
  async execute(input: InputOf<RefundCardAction>): Promise<void> {
    await Promise.resolve(input.order.value.orderId);
  }
}
@Action({ name: "notify-finance-team-action", description: "Tells finance a refund failed", input: { order: OrderRequestDto } })
export class NotifyFinanceTeamAction implements ActionHandler<NotifyFinanceTeamAction> {
  async execute(input: InputOf<NotifyFinanceTeamAction>): Promise<void> {
    await Promise.resolve(input.order.value.orderId);
  }
}
@Action({ name: "release-stock-action", description: "Releases the reserved stock", input: { reservation: StockReservationDto } })
export class ReleaseStockAction implements ActionHandler<ReleaseStockAction> {
  async execute(input: InputOf<ReleaseStockAction>): Promise<void> {
    await Promise.resolve(input.reservation.value.reservationId);
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
import { Workflow, start, toAction } from "agboss";
import { CarrierError, NotifyFinanceTeamAction, OrderFailedWorkflowFinish, OrderRequestDto, OrderShippedDto, OrderWorkflowFinish, OrderWorkflowStart, PaymentProviderError, RefundCardAction, ReleaseStockAction, ReserveStockAction, ShipOrderAction, StockReservationDto } from "./order.components.js";
-->

```ts
@Workflow({
  name: "order-workflow",
  version: "1.0.0",
  flow: [
    start(OrderWorkflowStart)
      .returns(OrderRequestDto)
      .toAction(ReserveStockAction)
      .returns(StockReservationDto) // data: ReleaseStockAction reads its reservationId
      .toAction(ShipOrderAction)
      .onError(
        CarrierError, // the carrier failed: undo what was done, newest first
        toAction(RefundCardAction) // side effects without output: no .returns
          .onError(
            PaymentProviderError, // the undo failed: a person takes over
            toAction(NotifyFinanceTeamAction)
              .toFinish(OrderFailedWorkflowFinish),
          )
          .toAction(ReleaseStockAction)
          .toFinish(OrderFailedWorkflowFinish),
      )
      .returns(OrderShippedDto)
      .toFinish(OrderWorkflowFinish),
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

## Why not automatic

A compensation the framework runs on its own would have to know the inverse of every step; for
model calls, tool calls and messages there is none, and a silent partial undo is worse than a
visible one. Writing the undo in the path keeps it reviewed, typed (the undo reads what the step
before returned, `StockReservationDto` here) and tested like the rest of the flow.
