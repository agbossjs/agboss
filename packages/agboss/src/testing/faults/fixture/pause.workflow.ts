import { Workflow, WorkflowFinish, WorkflowStart } from "../../../index.js";
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
import { FaultChargeAction, FaultReserveAction } from "./order.actions.js";
import {
  FaultChargeDto,
  FaultOrderDto,
  FaultPaymentDto,
  FaultReservationDto,
} from "./order.dto.js";
import { FaultPayAction } from "./pay.action.js";

/**
 * The fault fixture's paused order (#959): reserve (undoable), a question the order's thread owner
 * answers — the tree rests, its lease released, until `app.resume` —, then the fenced charge and the
 * payment of the order workflow. Run on every store set (the approved order of #811 is served over
 * A2A only): the scenarios kill a pod around its pause.
 */

const start = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

@ChannelRole({
  name: "fault-pause-question",
  description: "Asks the order's thread owner to approve it",
  ask: FaultApprovalAskDto,
  answer: FaultApprovalDto,
  answerer: PauseAnswerer.ThreadOwner,
})
export abstract class FaultPauseQuestion extends ChannelOf<FaultPauseQuestion> {}

/** Nobody is sent anything: the question waits for its `app.resume`. */
@Channel({ name: "fault-pause-channel", description: "Waits for the order's answer" })
export class FaultPauseChannel extends FaultPauseQuestion {
  send(): Promise<ChannelOutcome<FaultPauseQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({
  name: "fault-pause-workflow-start",
  description: "An order its thread owner approves",
  input: FaultOrderDto,
})
export class FaultPauseWorkflowStart {}

@WorkflowFinish({
  name: "fault-pause-workflow-finish",
  description: "The approved order, paid",
  output: FaultPaymentDto,
})
export class FaultPauseWorkflowFinish {}

@Workflow({
  name: "fault-pause-workflow",
  version: "1.0.0",
  flow: [
    start(FaultPauseWorkflowStart)
      .returns(FaultOrderDto)
      .toAction(FaultReserveAction)
      .returns(FaultReservationDto)
      .toAction(FaultAskAction)
      .returns(FaultApprovalAskDto)
      .toQuestion(FaultPauseQuestion)
      .returns(FaultApprovalDto)
      .toAction(FaultApprovedAction)
      .toAction(FaultChargeAction)
      .returns(FaultChargeDto)
      .toAction(FaultPayAction)
      .returns(FaultPaymentDto)
      .toFinish(FaultPauseWorkflowFinish),
  ],
})
export class FaultPauseWorkflow {}
