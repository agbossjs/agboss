import {
  ChildPlacement,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Tracked,
  Action,
} from "../../../index.js";
import type { Class } from "../../../components/injection.js";
import { NodeKind, type PathSource } from "../../../flow/ast.js";
import { fromSource, subPathFrom, type PathBuilder } from "../../../flow/path-builder.js";
import { FaultChargeAction, FaultReserveAction } from "./order.actions.js";
import { FaultBatchDto, FaultOrderDto, FaultPaymentDto } from "./order.dto.js";
import { FaultPayAction } from "./pay.action.js";

/**
 * The fault fixture's workflows (#484): one order — reserve (undoable), charge (a fenced business
 * row), pay (a call to the gateway under the order's business key), finish — and a batch of
 * orders, each a child queued for any instance (`ChildPlacement.AnyWorker`).
 */

/**
 * The path builder without its generated types: the fixture ships inside the package, where no
 * `.agboss/types.d.ts` types its workflows (the same AST as the typed `start`).
 */
const onStart = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

const toWorkflow = (target: Class): PathBuilder<undefined> =>
  subPathFrom({ kind: "side" })
    .toWorkflow(target);

@WorkflowStart({
  name: "fault-order-workflow-start",
  description: "An order",
  input: FaultOrderDto,
})
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
  placement: ChildPlacement.AnyWorker,
  flow: [
    onStart(FaultOrderWorkflowStart)
      .toAction(FaultReserveAction)
      .toAction(FaultChargeAction)
      .toAction(FaultPayAction)
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

@Action({
  name: "fault-batch-action",
  description: "Every order, paid",
  input: { payments: listOf(FaultPaymentDto) },
  output: FaultBatchDto,
})
export class FaultBatchAction {
  async execute(input: {
    readonly payments: readonly Tracked<FaultPaymentDto>[];
  }): Promise<FaultBatchDto> {
    return { orderIds: input.payments.map((payment) => payment.orderId) };
  }
}

@WorkflowFinish({
  name: "fault-batch-workflow-finish",
  description: "Every order, paid",
  output: FaultBatchDto,
})
export class FaultBatchWorkflowFinish {}

@Workflow({
  name: "fault-batch-workflow",
  version: "1.0.0",
  flow: [
    onStart(FaultBatchWorkflowStart)
      .forEachItem(toWorkflow(FaultOrderWorkflow), { takeFirst: 8, maxConcurrency: 4 })
      .join()
      .toAction(FaultBatchAction)
      .toFinish(FaultBatchWorkflowFinish),
  ],
})
export class FaultBatchWorkflow {}
