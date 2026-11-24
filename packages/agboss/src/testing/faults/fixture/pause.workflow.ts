import { PauseExpiration,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pauseKeyOf,
  type DecideExpiration, ExternalTask } from "../../../index.js";
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
import { FaultChargeAction, FaultReserveAction } from "./order.actions.js";
import { FaultOrderDto, FaultPaymentDto } from "./order.dto.js";
import { FaultPayAction } from "./pay.action.js";
import { FaultPodLink } from "./pod-link.js";
import { seconds, days } from "../../../units/index.js";
import { PauseRespondent } from "../../../pause/respondent.js";
import { Ttl } from "../../../index.js";

/**
 * The fault fixture's paused order (#959): reserve (undoable), a question the order's thread owner
 * answers — the tree rests, its lease released, until `app.resume` —, then the fenced charge and the
 * payment of the order workflow. Run on every store set (the approved order of #811 is served over
 * A2A only): the scenarios kill a pod around its pause.
 */

const onStart = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

@ExternalTask({
  name: "fault-pause-external-task",
  description: "Asks the order's thread owner to approve it",
  input: FaultApprovalAskDto,
  output: FaultApprovalDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class FaultPauseExternalTask {}

/**
 * Nobody is sent anything: the question waits for its `app.resume`. Each send is told to the test
 * (#946): the pause's key and, for a reassignment, its assignee and the key of the pause it
 * replaces — and its id, which a channel is given to be answered with (the test resumes it).
 */
@Channel({
  name: "fault-pause-channel",
  description: "Waits for the order's answer",
  deps: [FaultPodLink],
  target: FaultPauseExternalTask,
  ttl: days(1),
})
export class FaultPauseChannel {
  constructor(private readonly faultPodLink: FaultPodLink) {
  }

  send(ask: {
    readonly pauseId: string;
    readonly assignees?: readonly string[];
    readonly replaces?: { readonly pauseId: string };
  }): Promise<ChannelOutcome<FaultPauseExternalTask>> {
    this.faultPodLink.emit("pause-sent", {
      pauseKey: pauseKeyOf("default", ask.pauseId),
      pauseId: ask.pauseId,
      ...(ask.assignees?.[0] === undefined ? {} : { assignee: ask.assignees[0] }),
      ...(ask.replaces === undefined
        ? {}
        : { replacesKey: pauseKeyOf("default", ask.replaces.pauseId) }),
    });
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FaultPauseWorkflowStart)
      .toAction(FaultReserveAction)
      .toAction(FaultAskAction)
      .toExternalTask(FaultPauseExternalTask)
      .toAction(FaultApprovedAction)
      .toAction(FaultChargeAction)
      .toAction(FaultPayAction)
      .toFinish(FaultPauseWorkflowFinish),
  ],
})
export class FaultPauseWorkflow {}

/** How long the expiring question waits, in the fault clock's time (3 s of real time at scale 10). */
export const FAULT_EXPIRES_IN = seconds(30);

@ExternalTask({
  name: "fault-expiring-external-task",
  description: "Asks the order's thread owner to approve it within 30 seconds",
  input: FaultApprovalAskDto,
  output: FaultApprovalDto,
  respondent: PauseRespondent.Owner,
  timeout: FAULT_EXPIRES_IN,
})
export class FaultExpiringExternalTask {}

/**
 * Nobody is sent anything; when nobody answers in time the channel approves the order itself and
 * tells the test each time its decision was asked (a handler a crash lets run twice, #941 I5).
 */
@Channel({
  name: "fault-expiring-channel",
  description: "Approves the order itself when nobody answers",
  deps: [FaultPodLink],
  target: FaultExpiringExternalTask,
  ttl: days(1),
})
export class FaultExpiringChannel {
  constructor(private readonly faultPodLink: FaultPodLink) {
  }

  send(): Promise<ChannelOutcome<FaultExpiringExternalTask>> {
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FaultExpiringWorkflowStart)
      .toAction(FaultReserveAction)
      .toAction(FaultAskAction)
      .toExternalTask(FaultExpiringExternalTask)
      .toAction(FaultApprovedAction)
      .toAction(FaultChargeAction)
      .toAction(FaultPayAction)
      .toFinish(FaultExpiringWorkflowFinish),
  ],
})
export class FaultExpiringWorkflow {}
