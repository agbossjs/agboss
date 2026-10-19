import {
  EmptyEnvironment,
  Agent,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import {
  BatchSummaryDto,
  ConfirmOrderTool,
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  PauseLog,
  RefundDoneDto,
  RefundRequestDto,
  RefundTool,
  SeenPausedExecutionRepository,
} from "./pauses.workflow.js";

/**
 * #267 × #263 — pauses inside child workflows: a child whose agent waits on a channel role, alone
 * (the customer confirms: `PauseAnswerer.ThreadOwner`, its id in `result.pending`) or one child per
 * order, several waiting at once (the finance desk: `PauseAnswerer.Channel`, its id sent to the
 * desk). Every pause shows in the root's `result.pending` and is resumed by its id.
 */

@WorkflowStart({
  name: "refund-one-workflow-start",
  description: "One order",
  input: RefundRequestDto,
})
export class RefundOneWorkflowStart {}

@WorkflowFinish({
  name: "refund-one-workflow-finish",
  description: "The order refunded",
  output: RefundDoneDto,
})
export class RefundOneWorkflowFinish {}

/** Refunds (the desk approves) or confirms (the customer does) one order. */
@Agent({
  name: "child-refund-agent",
  description: "Handles one order",
  prompt: "Handle the order.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool, ConfirmOrderTool],
  input: { request: RefundRequestDto },
  output: RefundDoneDto,
})
export class ChildRefundAgent {}

/** The child: one order, one agent that may wait for an answer. */
@Workflow({
  name: "refund-one-workflow",
  version: "1.0.0",
  flow: [
    start(RefundOneWorkflowStart)
      .returns(RefundRequestDto)
      .toAgent(ChildRefundAgent)
      .returns(RefundDoneDto)
      .toFinish(RefundOneWorkflowFinish),
  ],
})
export class RefundOneWorkflow {}

@WorkflowStart({
  name: "single-child-workflow-start",
  description: "One order",
  input: RefundRequestDto,
})
export class SingleChildWorkflowStart {}

@WorkflowFinish({
  name: "single-child-workflow-finish",
  description: "The order handled",
  output: RefundDoneDto,
})
export class SingleChildWorkflowFinish {}

/** One child: the parent goes on to its finish once the child's pause is answered. */
@Workflow({
  name: "single-child-workflow",
  version: "1.0.0",
  flow: [
    start(SingleChildWorkflowStart)
      .returns(RefundRequestDto)
      .toWorkflow(RefundOneWorkflow)
      .returns(RefundDoneDto)
      .toFinish(SingleChildWorkflowFinish),
  ],
})
export class SingleChildWorkflow {}

@WorkflowStart({
  name: "child-batch-workflow-start",
  description: "The orders to refund",
  input: listOf(RefundRequestDto),
})
export class ChildBatchWorkflowStart {}

@WorkflowFinish({
  name: "child-batch-workflow-finish",
  description: "What was refunded",
  input: { refunds: listOf(RefundDoneDto) },
  output: BatchSummaryDto,
})
export class ChildBatchWorkflowFinish {
  finish(input: {
    readonly refunds: readonly Produced<RefundDoneDto, unknown>[];
  }): BatchSummaryDto {
    return {
      text: input.refunds
        .map((refund) => refund.value.orderId)
        .join(", "),
    };
  }
}

/** One child per order: several children wait at once, each resumed by its own pause's id. */
@Workflow({
  name: "child-batch-workflow",
  version: "1.0.0",
  flow: [
    start(ChildBatchWorkflowStart)
      .returns(listOf(RefundRequestDto))
      .toParallelWorkflows(RefundOneWorkflow, { maxConcurrency: 3, maxItems: 5 })
      .join()
      .returns(listOf(RefundDoneDto))
      .toFinish(ChildBatchWorkflowFinish),
  ],
})
export class ChildBatchWorkflow {}

@Application({
  name: "child-pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SingleChildWorkflow, ChildBatchWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
  ],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class ChildPausesApplication {}
