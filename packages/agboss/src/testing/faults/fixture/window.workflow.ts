import { Action, Workflow, WorkflowFinish, WorkflowStart, type Tracked, ExternalTask } from "../../../index.js";
import { Channel } from "../../../components/decorators.js";
import { ChannelOutcome } from "../../../channels/channel-outcome.js";
import type { Class } from "../../../components/injection.js";
import { NodeKind, type PathSource } from "../../../flow/ast.js";
import { fromSource, type PathBuilder } from "../../../flow/path-builder.js";
import {
  FaultApprovalAskDto,
  FaultApprovalDto,
  FaultApprovedAction,
  FaultAskAction,
} from "./approval.workflow.js";
import {
  FaultChargeAction,
  FaultChargeDeclinedError,
  FaultReserveAction,
} from "./order.actions.js";
import { FaultOrderDto, FaultPaymentDto, FaultReservationDto } from "./order.dto.js";
import { FaultPayAction } from "./pay.action.js";
import { FaultPauseExternalTask, FaultPauseWorkflow } from "./pause.workflow.js";
import { PauseRespondent } from "../../../pause/respondent.js";
import { days } from "../../../units/index.js";

/**
 * The fault fixture's trees for the writes window at an answer (#1098), run on every store set:
 * - the child-paused order: the paused order of #959 as an own-thread child (ADR-0022) of a parent
 *   that waits for it — its question is the child's, answered through the parent's tree;
 * - the twice-approved order: reserve, a question, a second question, then the fenced charge and
 *   the payment — two pauses in a row, so a second resume can wait while the first one's holder
 *   takes its answer too.
 */

const onStart = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

@WorkflowStart({
  name: "fault-child-pause-workflow-start",
  description: "An order its child approves and pays",
  input: FaultOrderDto,
})
export class FaultChildPauseWorkflowStart {}

@WorkflowFinish({
  name: "fault-child-pause-workflow-finish",
  description: "The order its child paid",
  output: FaultPaymentDto,
})
export class FaultChildPauseWorkflowFinish {}

@Workflow({
  name: "fault-child-pause-workflow",
  version: "1.0.0",
  flow: [
    onStart(FaultChildPauseWorkflowStart)
      .toWorkflow(FaultPauseWorkflow)
      .toFinish(FaultChildPauseWorkflowFinish),
  ],
})
export class FaultChildPauseWorkflow {}

@ExternalTask({
  name: "fault-second-pause-external-task",
  description: "Asks the order's thread owner to approve it once more",
  input: FaultApprovalAskDto,
  output: FaultApprovalDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class FaultSecondPauseExternalTask {}

/** Nobody is sent anything: the second question waits for its `app.resume`. */
@Channel({ name: "fault-second-pause-channel", description: "Waits for the order's second answer", target: FaultSecondPauseExternalTask, ttl: days(1) })
export class FaultSecondPauseChannel {
  send(): Promise<ChannelOutcome<FaultSecondPauseExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Action({
  name: "fault-ask-again-action",
  description: "Asks for the reserved order's second approval",
  input: { reservation: FaultReservationDto },
  output: FaultApprovalAskDto,
})
export class FaultAskAgainAction {
  execute(input: {
    readonly reservation: Tracked<FaultReservationDto>;
  }): Promise<FaultApprovalAskDto> {
    return Promise.resolve({ orderId: input.reservation.orderId });
  }
}

@Action({
  name: "fault-approved-again-action",
  description: "Goes on with an order approved twice; a refusal is a real failure",
  input: { approval: FaultApprovalDto },
})
export class FaultApprovedAgainAction {
  execute(input: { readonly approval: Tracked<FaultApprovalDto> }): Promise<void> {
    if (input.approval.approved) return Promise.resolve();
    return Promise.reject(new FaultChargeDeclinedError("the order was not approved again"));
  }
}

@WorkflowStart({
  name: "fault-twice-pause-workflow-start",
  description: "An order its thread owner approves twice",
  input: FaultOrderDto,
})
export class FaultTwicePauseWorkflowStart {}

@WorkflowFinish({
  name: "fault-twice-pause-workflow-finish",
  description: "The order approved twice, paid",
  output: FaultPaymentDto,
})
export class FaultTwicePauseWorkflowFinish {}

@Workflow({
  name: "fault-twice-pause-workflow",
  version: "1.0.0",
  flow: [
    onStart(FaultTwicePauseWorkflowStart)
      .toAction(FaultReserveAction)
      .toAction(FaultAskAction)
      .toExternalTask(FaultPauseExternalTask)
      .toAction(FaultApprovedAction)
      .toAction(FaultAskAgainAction)
      .toExternalTask(FaultSecondPauseExternalTask)
      .toAction(FaultApprovedAgainAction)
      .toAction(FaultChargeAction)
      .toAction(FaultPayAction)
      .toFinish(FaultTwicePauseWorkflowFinish),
  ],
})
export class FaultTwicePauseWorkflow {}
