import {
  PauseExpiration,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pauseKeyOf,
  type DecideExpiration,
} from "../../../index.js";
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
import { FaultPodLink } from "./pod-link.js";
import { seconds } from "../../../units/index.js";

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

/** How long the expiring question waits, in the fault clock's time (3 s of real time at scale 10). */
export const FAULT_EXPIRES_IN = seconds(30);

@ChannelRole({
  name: "fault-expiring-question",
  description: "Asks the order's thread owner to approve it within 30 seconds",
  ask: FaultApprovalAskDto,
  answer: FaultApprovalDto,
  answerer: PauseAnswerer.ThreadOwner,
  expiresIn: FAULT_EXPIRES_IN,
})
export abstract class FaultExpiringQuestion extends ChannelOf<FaultExpiringQuestion> {}

/**
 * Nobody is sent anything; when nobody answers in time the channel approves the order itself and
 * tells the test each time its decision was asked (a handler a crash lets run twice, #941 I5).
 */
@Channel({
  name: "fault-expiring-channel",
  description: "Approves the order itself when nobody answers",
  deps: [FaultPodLink],
})
export class FaultExpiringChannel extends FaultExpiringQuestion {
  constructor(private readonly faultPodLink: FaultPodLink) {
    super();
  }

  send(): Promise<ChannelOutcome<FaultExpiringQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  // untyped here: the package's own fixtures have no generated tables (the role's answer is a type of them)
  onPauseExpired(ask: { readonly pauseId: string }): DecideExpiration<{ approved: boolean }> {
    this.faultPodLink.emit("pause-expiry-asked", { pauseKey: pauseKeyOf("default", ask.pauseId) });
    return PauseExpiration.decide({ approved: true });
  }
}

@WorkflowStart({
  name: "fault-expiring-workflow-start",
  description: "An order its thread owner approves within 30 seconds",
  input: FaultOrderDto,
})
export class FaultExpiringWorkflowStart {}

@WorkflowFinish({
  name: "fault-expiring-workflow-finish",
  description: "The approved order, paid",
  output: FaultPaymentDto,
})
export class FaultExpiringWorkflowFinish {}

@Workflow({
  name: "fault-expiring-workflow",
  version: "1.0.0",
  flow: [
    start(FaultExpiringWorkflowStart)
      .returns(FaultOrderDto)
      .toAction(FaultReserveAction)
      .returns(FaultReservationDto)
      .toAction(FaultAskAction)
      .returns(FaultApprovalAskDto)
      .toQuestion(FaultExpiringQuestion)
      .returns(FaultApprovalDto)
      .toAction(FaultApprovedAction)
      .toAction(FaultChargeAction)
      .returns(FaultChargeDto)
      .toAction(FaultPayAction)
      .returns(FaultPaymentDto)
      .toFinish(FaultExpiringWorkflowFinish),
  ],
})
export class FaultExpiringWorkflow {}
