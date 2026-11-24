import { Bool, Text } from "../../../src/dto/index.js";
import {
  Agent,
  Channel,
  ChannelOutcome,
  EmptyEnvironment,
  Observer,
  optional,
  PauseRespondent,
  ChannelListener,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ChannelPauseClosedEvent,
  type ChannelPauseJoinFailedEvent,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ChannelListenerClosedEvent,
  type ChannelListenerJoinFailedEvent,
  type ChannelListenerOpenedEvent,
  inline,
  ToolApproval,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Action } from "../../../src/flow/decorators/action.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import { minutes, days } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { onStart, toAction, toAgent } from "./paths.js";

/**
 * #945 AC4 — legal, finance, the CFO and the COO approve in a plain four-way `.join()` (FailFast);
 * the CFO's approval expires. `.onError(PauseExpiredError, …)` escalates to the CEO from the
 * answers already settled; the approvers who answered are told the launch failed, the one still
 * waiting is withdrawn. What happened is in `je`, reset per test.
 */

export class ApprovalRequestDto {
  @Text({ prompt: "what is approved" })
  what!: string;
}

export class LegalDecisionDto {
  @Bool({ prompt: "legal approves" })
  approved!: boolean;
}

export class FinanceDecisionDto {
  @Bool({ prompt: "finance approves" })
  approved!: boolean;
}

export class CfoDecisionDto {
  @Bool({ prompt: "the CFO approves" })
  approved!: boolean;
}

export class CooDecisionDto {
  @Bool({ prompt: "the COO approves" })
  approved!: boolean;
}

export class EscalationDto {
  @Text({ prompt: "what the CEO is told" })
  text!: string;
}

export const je = {
  /** The asks the approvers' desk was sent. */
  sent: [] as ChannelAsk<JoinApproverQuestionToolApproval>[],
  closed: [] as ChannelPauseClosedEvent<JoinApproverQuestionToolApproval>[],
  /** `joinFailed` told to the desk, and to the listener. */
  joinFailed: [] as ChannelPauseJoinFailedEvent<JoinApproverQuestionToolApproval>[],
  heard: [] as ChannelListenerJoinFailedEvent[],
  /** What the escalation read, by approver. */
  escalation: [] as Record<string, boolean | undefined>[],
  ended: [] as ExecutionEndEvent[],
  errors: [] as Error[],
};

export function resetJoinExpiry(): void {
  for (const list of Object.values(je)) list.length = 0;
}

@ToolApproval({
  name: "join-approver-question-tool-approval",
  description: "Asks an approver",
  input: ApprovalRequestDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class JoinApproverQuestionToolApproval {}

/** What every approvers' channel does: asked, it waits and tells the test what it hears. */
export abstract class JoinApproverChannelBase {
  send(
    ask: ChannelAsk<JoinApproverQuestionToolApproval>,
  ): Promise<ChannelOutcome<JoinApproverQuestionToolApproval>> {
    je.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  onPauseClosed(event: ChannelPauseClosedEvent<JoinApproverQuestionToolApproval>): Promise<void> {
    je.closed.push(event);
    return Promise.resolve();
  }

  onPauseJoinFailed(
    event: ChannelPauseJoinFailedEvent<JoinApproverQuestionToolApproval>,
  ): Promise<void> {
    je.joinFailed.push(event);
    return Promise.resolve();
  }
}

@Channel({
  name: "join-approver-desk-channel",
  description: "Asks the approvers",
  target: JoinApproverQuestionToolApproval,
  ttl: days(1),
})
export class JoinApproverDeskChannel extends JoinApproverChannelBase {}

@ChannelListener({ name: "join-failed-pause-listener", includePauseIds: true })
export class JoinFailedPauseListener {
  onPauseOpened(event: ChannelListenerOpenedEvent): Promise<void> {
    return Promise.resolve();
  }

  onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    return Promise.resolve();
  }

  onPauseJoinFailed(event: ChannelListenerJoinFailedEvent): Promise<void> {
    je.heard.push(event);
    return Promise.resolve();
  }
}

@Tool({
  name: "approve-tool",
  description: "An approver approves",
  approval: JoinApproverQuestionToolApproval,
  input: ApprovalRequestDto,
  output: ApprovalRequestDto,
})
export class ApproveTool {
  execute(input: ApprovalRequestDto): Promise<ApprovalRequestDto> {
    return Promise.resolve(input);
  }
}

/** The same approvers with 30 minutes: the channel is the same, asked under its own target. */
@ToolApproval({
  name: "join-approver-thirty-tool-approval",
  description: "Asks an approver within 30 minutes",
  input: ApprovalRequestDto,
  respondent: PauseRespondent.Delegate,
  timeout: minutes(30),
})
export class JoinApproverThirtyToolApproval {}

@Channel({
  name: "join-approver-thirty-desk-channel",
  description: "Asks the approvers, within 30 minutes",
  target: JoinApproverThirtyToolApproval,
  ttl: days(1),
})
export class JoinApproverThirtyDeskChannel extends JoinApproverChannelBase {}

@Tool({
  name: "approve-in-30-tool",
  description: "An approver approves within 30 minutes",
  approval: JoinApproverThirtyToolApproval,
  input: ApprovalRequestDto,
  output: ApprovalRequestDto,
})
export class ApproveInThirtyTool {
  execute(input: ApprovalRequestDto): Promise<ApprovalRequestDto> {
    return Promise.resolve(input);
  }
}

const MODEL = "moonshotai/kimi-k2.6";

@Agent({
  name: "legal-approver-agent",
  description: "Legal approves",
  prompt: inline("Approve."),
  model: MODEL,
  tools: [ApproveTool],
  input: { request: ApprovalRequestDto },
  output: LegalDecisionDto,
})
export class LegalApproverAgent {}

@Agent({
  name: "finance-approver-agent",
  description: "Finance approves",
  prompt: inline("Approve."),
  model: MODEL,
  tools: [ApproveTool],
  input: { request: ApprovalRequestDto },
  output: FinanceDecisionDto,
})
export class FinanceApproverAgent {}

@Agent({
  name: "cfo-approver-agent",
  description: "The CFO approves within 30 minutes",
  prompt: inline("Approve."),
  model: MODEL,
  tools: [ApproveInThirtyTool],
  input: { request: ApprovalRequestDto },
  output: CfoDecisionDto,
})
export class CfoApproverAgent {}

@Agent({
  name: "coo-approver-agent",
  description: "The COO approves",
  prompt: inline("Approve."),
  model: MODEL,
  tools: [ApproveTool],
  input: { request: ApprovalRequestDto },
  output: CooDecisionDto,
})
export class CooApproverAgent {}

@WorkflowStart({
  name: "join-expiry-workflow-start",
  description: "What needs approval",
  input: ApprovalRequestDto,
})
export class JoinExpiryWorkflowStart {}

@WorkflowFinish({
  name: "join-expiry-approved-workflow-finish",
  description: "Everyone approved",
  output: CooDecisionDto,
})
export class JoinExpiryApprovedWorkflowFinish {}

@WorkflowFinish({
  name: "join-expiry-escalated-workflow-finish",
  description: "The CEO was told",
  output: EscalationDto,
})
export class JoinExpiryEscalatedWorkflowFinish {}

/** The approval an optional input holds, when its branch answered. */
const approvedOf = (decision: { readonly approved: boolean } | undefined) => decision?.approved;

/** The CEO is told what the approvers already said. */
@Action({
  name: "escalate-to-ceo-action",
  description: "Shows the CEO the answers already given",
  input: {
    legal: optional(LegalDecisionDto),
    finance: optional(FinanceDecisionDto),
    cfo: optional(CfoDecisionDto),
    coo: optional(CooDecisionDto),
  },
  output: EscalationDto,
})
export class EscalateToCeoAction implements ActionHandler<EscalateToCeoAction> {
  execute(input: InputOf<EscalateToCeoAction>): Promise<OutputOf<EscalateToCeoAction>> {
    je.escalation.push({
      legal: approvedOf(input.legal),
      finance: approvedOf(input.finance),
      cfo: approvedOf(input.cfo),
      coo: approvedOf(input.coo),
    });
    return Promise.resolve({ text: "escalated" });
  }
}

@Workflow({
  name: "join-expiry-workflow",
  version: "1.0.0",
  flow: [
    onStart(JoinExpiryWorkflowStart)
      .inParallel([
        toAgent(LegalApproverAgent),
        toAgent(FinanceApproverAgent),
        toAgent(CfoApproverAgent),
        toAgent(CooApproverAgent),
      ])
      .join()
      .onError(
        PauseExpiredError,
        toAction(EscalateToCeoAction)
          .toFinish(JoinExpiryEscalatedWorkflowFinish),
      )
      .toFinish(JoinExpiryApprovedWorkflowFinish),
  ],
})
export class JoinExpiryWorkflow {}

@Observer()
export class JoinExpiryLog {
  onExecutionEnd(event: ExecutionEndEvent): void {
    je.ended.push(event);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    je.errors.push(event.error);
  }
}

@Application({
  name: "join-expiry-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [JoinExpiryWorkflow],
  providers: [
    JoinApproverDeskChannel,
    JoinApproverThirtyDeskChannel,
    JoinFailedPauseListener,
    RecordingLogger,
  ],
  observers: [JoinExpiryLog],
  budgets: TEST_BUDGETS,
})
export class JoinExpiryApplication {}
