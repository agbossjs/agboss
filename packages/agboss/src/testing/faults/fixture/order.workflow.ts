import {
  ChildPlacement,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Produced,
} from "../../../index.js";
import type { Class } from "../../../components/injection.js";
import { NodeKind, type PathSource } from "../../../flow/ast.js";
import { fromSource, type PathBuilder } from "../../../flow/path-builder.js";
import { FaultChargeAction, FaultReserveAction } from "./order.actions.js";
import {
  FaultBatchDto,
  FaultChargeDto,
  FaultOrderDto,
  FaultPaymentDto,
  FaultReservationDto,
} from "./order.dto.js";
import { FaultPayAction } from "./pay.action.js";

/**
 * The fault fixture's workflows (#484): one order — reserve (undoable), charge (a fenced business
 * row), pay (a call to the gateway under the order's business key), finish — and a batch of
 * orders, each a child queued for any instance (`ChildPlacement.AnyInstance`).
 */

/**
 * The path builder without its generated types: the fixture ships inside the package, where no
 * `.agboss/types.d.ts` types its workflows (the same AST as the typed `start`).
 */
const start = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

@WorkflowStart({ name: "fault-order-workflow-start", description: "An order", input: FaultOrderDto })
export class FaultOrderWorkflowStart {}

@WorkflowFinish({
  name: "fault-order-workflow-finish",
  description: "The order, paid",
  output: FaultPaymentDto,
})
export class FaultOrderWorkflowFinish {}

@Workflow({
  name: "fault-order-workflow",
  version: "1.0.0",
  flow: [
    start(FaultOrderWorkflowStart)
      .returns(FaultOrderDto)
      .toAction(FaultReserveAction)
      .returns(FaultReservationDto)
      .toAction(FaultChargeAction)
      .returns(FaultChargeDto)
      .toAction(FaultPayAction)
      .returns(FaultPaymentDto)
      .toFinish(FaultOrderWorkflowFinish),
  ],
})
export class FaultOrderWorkflow {}

@WorkflowStart({
  name: "fault-batch-workflow-start",
  description: "Orders, each a child on any instance",
  input: listOf(FaultOrderDto),
})
export class FaultBatchWorkflowStart {}

@WorkflowFinish({
  name: "fault-batch-workflow-finish",
  description: "Every order, paid",
  input: { payments: listOf(FaultPaymentDto) },
  output: FaultBatchDto,
})
export class FaultBatchWorkflowFinish {
  finish(input: {
    readonly payments: readonly Produced<FaultPaymentDto, unknown>[];
  }): FaultBatchDto {
    return { orderIds: input.payments.map((payment) => payment.value.orderId) };
  }
}

@Workflow({
  name: "fault-batch-workflow",
  version: "1.0.0",
  flow: [
    start(FaultBatchWorkflowStart)
      .returns(listOf(FaultOrderDto))
      .toParallelWorkflows(FaultOrderWorkflow, {
        maxConcurrency: 4,
        maxItems: 8,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(FaultPaymentDto))
      .toFinish(FaultBatchWorkflowFinish),
  ],
})
export class FaultBatchWorkflow {}
