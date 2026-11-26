import { ComponentKind } from "../../../flow/runtime/records.js";
import {
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Action,
  type Tracked,
  ExternalTask,
} from "../../../index.js";
import { Channel } from "../../../components/decorators.js";
import { ChannelOutcome } from "../../../channels/channel-outcome.js";
import type { Class } from "../../../components/injection.js";
import { Bool, Text } from "../../../dto/index.js";
import type { PathSource } from "../../../flow/ast.js";
import { fromSource, type PathBuilder } from "../../../flow/path-builder.js";
import {
  FaultChargeAction,
  FaultChargeDeclinedError,
  FaultReserveAction,
} from "./order.actions.js";
import { FaultOrderDto, FaultPaymentDto, FaultReservationDto } from "./order.dto.js";
import { FaultPayAction } from "./pay.action.js";
import { PauseRespondent } from "../../../pause/respondent.js";
import { days } from "../../../units/index.js";
import { Ttl } from "../../../index.js";

/**
 * The fault fixture's approved order (#811 AC4, served over A2A only): reserve (undoable), then a
 * question its caller answers — the task rests `INPUT_REQUIRED` until a follow-up resumes it —,
 * then the fenced charge and the payment of the order workflow. A resume racing a cancel is decided
 * by the pause's atomic transition: the scenario reads which won from the charge and the payment.
 */

const onStart = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: ComponentKind.WorkflowStart, node: source });

/** What the question asks: the order to approve. */
export class FaultApprovalAskDto {
  @Text({ prompt: "the order to approve" })
  orderId!: string;
}

/** The caller's answer. */
export class FaultApprovalDto {
  @Bool({ prompt: "whether the order may be charged" })
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
    readonly reservation: Tracked<FaultReservationDto>;
  }): Promise<FaultApprovalAskDto> {
    return Promise.resolve({ orderId: input.reservation.orderId });
  }
}

@Action({
  name: "fault-approved-action",
  description: "Goes on with an approved order; a refusal is a real failure",
  input: { approval: FaultApprovalDto },
})
export class FaultApprovedAction {
  execute(input: { readonly approval: Tracked<FaultApprovalDto> }): Promise<void> {
    if (input.approval.approved) return Promise.resolve();
    return Promise.reject(new FaultChargeDeclinedError("the order was not approved"));
  }
}

@ExternalTask({
  name: "fault-approval-external-task",
  description: "Asks the task's caller to approve its order",
  input: FaultApprovalAskDto,
  output: FaultApprovalDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class FaultApprovalExternalTask {}

/** The caller answers over A2A: the question waits for its follow-up. */
@Channel({
  name: "fault-caller-channel",
  description: "The A2A task's caller",
  target: FaultApprovalExternalTask,
  ttl: days(1),
})
export class FaultCallerChannel {
  send(): Promise<ChannelOutcome<FaultApprovalExternalTask>> {
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FaultApprovalWorkflowStart)
      .toAction(FaultReserveAction)
      .toAction(FaultAskAction)
      .toExternalTask(FaultApprovalExternalTask)
      .toAction(FaultApprovedAction)
      .toAction(FaultChargeAction)
      .toAction(FaultPayAction)
      .toFinish(FaultApprovalWorkflowFinish),
  ],
})
export class FaultApprovalWorkflow {}
