import { start, toAction } from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler, FinishHandler } from "../../../src/flow/handlers.js";
import { OrderRequestDto, OrderShippedDto, StockReservationDto } from "./dtos.js";

/** #272 example 3 — errors and an explicit rollback, with a branch for a failed rollback. */

export class CarrierError extends Error {}
export class PaymentProviderError extends Error {}

@WorkflowStart({
  name: "order-workflow-start",
  description: "An order to ship",
  input: OrderRequestDto,
})
export class OrderWorkflowStart {}

@Action({
  name: "reserve-stock-action",
  description: "Reserves the stock",
  input: {
    order: OrderRequestDto,
  },
  output: StockReservationDto,
})
export class ReserveStockAction implements ActionHandler<ReserveStockAction> {
  execute(input: InputOf<ReserveStockAction>): Promise<OutputOf<ReserveStockAction>> {
    return Promise.resolve({ reservationId: `reservation-${input.order.value.orderId}` });
  }
}

@Action({
  name: "ship-order-action",
  description: "Hands the order to the carrier",
  input: {
    order: OrderRequestDto,
  },
  output: OrderShippedDto,
})
export class ShipOrderAction implements ActionHandler<ShipOrderAction> {
  execute(input: InputOf<ShipOrderAction>): Promise<OutputOf<ShipOrderAction>> {
    return Promise.resolve({ trackingNumber: `track-${input.order.value.orderId}` });
  }
}

@Action({
  name: "refund-card-action",
  description: "Refunds the card",
  input: {
    order: OrderRequestDto,
  },
})
export class RefundCardAction implements ActionHandler<RefundCardAction> {
  async execute(input: InputOf<RefundCardAction>): Promise<void> {
    await Promise.resolve(input.order.value.orderId);
  }
}

@Action({
  name: "notify-finance-team-action",
  description: "Tells finance a refund failed",
  input: {
    order: OrderRequestDto,
  },
})
export class NotifyFinanceTeamAction implements ActionHandler<NotifyFinanceTeamAction> {
  async execute(input: InputOf<NotifyFinanceTeamAction>): Promise<void> {
    await Promise.resolve(input.order.value.orderId);
  }
}

@Action({
  name: "release-stock-action",
  description: "Releases the reserved stock",
  input: {
    reservation: StockReservationDto,
  },
})
export class ReleaseStockAction implements ActionHandler<ReleaseStockAction> {
  async execute(input: InputOf<ReleaseStockAction>): Promise<void> {
    await Promise.resolve(input.reservation.value.reservationId);
  }
}

@WorkflowFinish({
  name: "order-failed-workflow-finish",
  description: "The order could not be shipped",
  output: OrderRequestDto,
})
export class OrderFailedWorkflowFinish {}

@WorkflowFinish({
  name: "order-workflow-finish",
  description: "The shipped order",
  input: {
    shipped: OrderShippedDto,
  },
  output: OrderShippedDto,
})
export class OrderWorkflowFinish implements FinishHandler<OrderWorkflowFinish> {
  finish(input: InputOf<OrderWorkflowFinish>): OutputOf<OrderWorkflowFinish> {
    return { trackingNumber: input.shipped.value.trackingNumber };
  }
}

export const orderPaths = [
  start(OrderWorkflowStart)
    .returns(OrderRequestDto)
    .toAction(ReserveStockAction)
    .returns(StockReservationDto)
    .toAction(ShipOrderAction)
    .onError(
      CarrierError,
      toAction(RefundCardAction)
        .onError(
          PaymentProviderError,
          toAction(NotifyFinanceTeamAction)
            .toFinish(OrderFailedWorkflowFinish),
        )
        .toAction(ReleaseStockAction)
        .toFinish(OrderFailedWorkflowFinish),
    )
    .returns(OrderShippedDto)
    .toFinish(OrderWorkflowFinish),
] as const;

@Workflow({
  name: "order-workflow",
  version: "1.0.0",
  flow: orderPaths,
})
export class OrderWorkflow {}
