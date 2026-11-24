import { Action, Workflow, WorkflowFinish, WorkflowStart, type Produced } from "../../../index.js";
import { Channel } from "../../../components/decorators.js";
import { ChannelOf } from "../../../channels/channel-handler.js";
import { ChannelOutcome } from "../../../channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../channels/channel-role.decorator.js";
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
import { FaultPauseQuestion, FaultPauseWorkflow } from "./pause.workflow.js";

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

@ChannelRole({
  name: "fault-second-pause-question",
  description: "Asks the order's thread owner to approve it once more",
  ask: FaultApprovalAskDto,
  answer: FaultApprovalDto,
  answerer: PauseAnswerer.ThreadOwner,
})
export abstract class FaultSecondPauseQuestion extends ChannelOf<FaultSecondPauseQuestion> {}

/** Nobody is sent anything: the second question waits for its `app.resume`. */
@Channel({ name: "fault-second-pause-channel", description: "Waits for the order's second answer" })
export class FaultSecondPauseChannel extends FaultSecondPauseQuestion {
  send(): Promise<ChannelOutcome<FaultSecondPauseQuestion>> {
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
    readonly reservation: Produced<FaultReservationDto, unknown>;
  }): Promise<FaultApprovalAskDto> {
    return Promise.resolve({ orderId: input.reservation.value.orderId });
  }
}

@Action({
  name: "fault-approved-again-action",
  description: "Goes on with an order approved twice; a refusal is a real failure",
  input: { approval: FaultApprovalDto },
})
export class FaultApprovedAgainAction {
  execute(input: { readonly approval: Produced<FaultApprovalDto, unknown> }): Promise<void> {
    if (input.approval.value.approved) return Promise.resolve();
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
      .toExternalTask(FaultPauseQuestion)
      .toAction(FaultApprovedAction)
      .toAction(FaultAskAgainAction)
      .toExternalTask(FaultSecondPauseQuestion)
      .toAction(FaultApprovedAgainAction)
      .toAction(FaultChargeAction)
      .toAction(FaultPayAction)
      .toFinish(FaultTwicePauseWorkflowFinish),
  ],
})
export class FaultTwicePauseWorkflow {}
