import { Workflow, WorkflowFinish, WorkflowStart, Action, type Produced } from "../../../index.js";
import { Channel } from "../../../components/decorators.js";
import { ChannelOf } from "../../../channels/channel-handler.js";
import { ChannelOutcome } from "../../../channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../channels/channel-role.decorator.js";
import type { Class } from "../../../components/injection.js";
import { Flag, Text } from "../../../dto/index.js";
import { NodeKind, type PathSource } from "../../../flow/ast.js";
import { fromSource, type PathBuilder } from "../../../flow/path-builder.js";
import {
  FaultChargeAction,
  FaultChargeDeclinedError,
  FaultReserveAction,
} from "./order.actions.js";
import {
  FaultChargeDto,
  FaultOrderDto,
  FaultPaymentDto,
  FaultReservationDto,
} from "./order.dto.js";
import { FaultPayAction } from "./pay.action.js";

/**
 * The fault fixture's approved order (#811 AC4, served over A2A only): reserve (undoable), then a
 * question its caller answers — the task rests `INPUT_REQUIRED` until a follow-up resumes it —,
 * then the fenced charge and the payment of the order workflow. A resume racing a cancel is decided
 * by the pause's atomic transition: the scenario reads which won from the charge and the payment.
 */

const start = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

/** What the question asks: the order to approve. */
export class FaultApprovalAskDto {
  @Text({ prompt: "the order to approve" })
  orderId!: string;
}

/** The caller's answer. */
export class FaultApprovalDto {
  @Flag({ prompt: "whether the order may be charged" })
  approved!: boolean;
}

@Action({
  name: "fault-ask-action",
  description: "Asks for the reserved order's approval",
  input: { reservation: FaultReservationDto },
  output: FaultApprovalAskDto,
})
export class FaultAskAction {
  execute(input: {
    readonly reservation: Produced<FaultReservationDto, unknown>;
  }): Promise<FaultApprovalAskDto> {
    return Promise.resolve({ orderId: input.reservation.value.orderId });
  }
}

@Action({
  name: "fault-approved-action",
  description: "Goes on with an approved order; a refusal is a real failure",
  input: { approval: FaultApprovalDto },
})
export class FaultApprovedAction {
  execute(input: { readonly approval: Produced<FaultApprovalDto, unknown> }): Promise<void> {
    if (input.approval.value.approved) return Promise.resolve();
    return Promise.reject(new FaultChargeDeclinedError("the order was not approved"));
  }
}

@ChannelRole({
  name: "fault-approval-question",
  description: "Asks the task's caller to approve its order",
  ask: FaultApprovalAskDto,
  answer: FaultApprovalDto,
  answerer: PauseAnswerer.ThreadOwner,
})
export abstract class FaultApprovalQuestion extends ChannelOf<FaultApprovalQuestion> {}

/** The caller answers over A2A: the question waits for its follow-up. */
@Channel({ name: "fault-caller-channel", description: "The A2A task's caller" })
export class FaultCallerChannel extends FaultApprovalQuestion {
  send(): Promise<ChannelOutcome<FaultApprovalQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({
  name: "fault-approval-workflow-start",
  description: "An order its caller approves",
  input: FaultOrderDto,
})
export class FaultApprovalWorkflowStart {}

@WorkflowFinish({
  name: "fault-approval-workflow-finish",
  description: "The approved order, paid",
  output: FaultPaymentDto,
})
export class FaultApprovalWorkflowFinish {}

@Workflow({
  name: "fault-approval-workflow",
  version: "1.0.0",
  flow: [
    start(FaultApprovalWorkflowStart)
      .returns(FaultOrderDto)
      .toAction(FaultReserveAction)
      .returns(FaultReservationDto)
      .toAction(FaultAskAction)
      .returns(FaultApprovalAskDto)
      .toQuestion(FaultApprovalQuestion)
      .returns(FaultApprovalDto)
      .toAction(FaultApprovedAction)
      .toAction(FaultChargeAction)
      .returns(FaultChargeDto)
      .toAction(FaultPayAction)
      .returns(FaultPaymentDto)
      .toFinish(FaultApprovalWorkflowFinish),
  ],
})
export class FaultApprovalWorkflow {}
