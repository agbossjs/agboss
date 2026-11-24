import { Bool, Text } from "../../../src/dto/index.js";
import {
  Agent,
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  EmptyEnvironment,
  Observer,
  optional,
  PauseAnswerer,
  PauseListener,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ChannelPauseClosedEvent,
  type ChannelPauseJoinFailedEvent,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type PauseListenerClosedEvent,
  type PauseListenerHandler,
  type PauseListenerJoinFailedEvent,
  type PauseListenerOpenedEvent,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Action } from "../../../src/flow/decorators/action.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import { minutes } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { onStart, toAction } from "./paths.js";

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
  sent: [] as ChannelAsk<JoinApproverQuestion>[],
  closed: [] as ChannelPauseClosedEvent<JoinApproverQuestion>[],
  /** `joinFailed` told to the desk, and to the listener. */
  joinFailed: [] as ChannelPauseJoinFailedEvent<JoinApproverQuestion>[],
  heard: [] as PauseListenerJoinFailedEvent[],
  /** What the escalation read, by approver. */
  escalation: [] as Record<string, boolean | undefined>[],
  ended: [] as ExecutionEndEvent[],
  errors: [] as Error[],
};

export function resetJoinExpiry(): void {
  for (const list of Object.values(je)) list.length = 0;
}

@ChannelRole({
  name: "join-approver-question-channel",
  description: "Asks an approver",
  approves: ApprovalRequestDto,
  answerer: PauseAnswerer.Channel,
})
export abstract class JoinApproverQuestion extends ChannelOf<JoinApproverQuestion> {}

@Channel({ name: "join-approver-desk-channel", description: "Asks the approvers" })
export class JoinApproverDeskChannel extends JoinApproverQuestion {
  send(ask: ChannelAsk<JoinApproverQuestion>): Promise<ChannelOutcome<JoinApproverQuestion>> {
    je.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  override onPauseClosed(event: ChannelPauseClosedEvent<JoinApproverQuestion>): Promise<void> {
    je.closed.push(event);
    return Promise.resolve();
  }

  override onPauseJoinFailed(
    event: ChannelPauseJoinFailedEvent<JoinApproverQuestion>,
  ): Promise<void> {
    je.joinFailed.push(event);
    return Promise.resolve();
  }
}

@PauseListener({ name: "join-failed-pause-listener", allowAnswering: true })
export class JoinFailedPauseListener implements PauseListenerHandler {
  onPauseOpened(event: PauseListenerOpenedEvent): Promise<void> {
    return Promise.resolve();
  }

  onPauseClosed(event: PauseListenerClosedEvent): Promise<void> {
    return Promise.resolve();
  }

  onPauseJoinFailed(event: PauseListenerJoinFailedEvent): Promise<void> {
    je.heard.push(event);
    return Promise.resolve();
  }
}

@Tool({
  name: "approve-tool",
  description: "An approver approves",
  channel: JoinApproverQuestion,
  input: ApprovalRequestDto,
  output: ApprovalRequestDto,
})
export class ApproveTool {
  execute(input: ApprovalRequestDto): Promise<ApprovalRequestDto> {
    return Promise.resolve(input);
  }
}

@Tool({
  name: "approve-in-30-tool",
  description: "An approver approves within 30 minutes",
  channel: JoinApproverQuestion,
  expiresIn: minutes(30),
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
  prompt: "Approve.",
  model: MODEL,
  tools: [ApproveTool],
  input: { request: ApprovalRequestDto },
  output: LegalDecisionDto,
})
export class LegalApproverAgent {}

@Agent({
  name: "finance-approver-agent",
  description: "Finance approves",
  prompt: "Approve.",
  model: MODEL,
  tools: [ApproveTool],
  input: { request: ApprovalRequestDto },
  output: FinanceDecisionDto,
})
export class FinanceApproverAgent {}

@Agent({
  name: "cfo-approver-agent",
  description: "The CFO approves within 30 minutes",
  prompt: "Approve.",
  model: MODEL,
  tools: [ApproveInThirtyTool],
  input: { request: ApprovalRequestDto },
  output: CfoDecisionDto,
})
export class CfoApproverAgent {}

@Agent({
  name: "coo-approver-agent",
  description: "The COO approves",
  prompt: "Approve.",
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
const approvedOf = (decision: { readonly value: { readonly approved: boolean } } | undefined) =>
  decision?.value.approved;

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
      .toParallelAgents(
        LegalApproverAgent,
        FinanceApproverAgent,
        CfoApproverAgent,
        CooApproverAgent,
      )
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
  providers: [JoinApproverDeskChannel, JoinFailedPauseListener, RecordingLogger],
  observers: [JoinExpiryLog],
  budgets: TEST_BUDGETS,
})
export class JoinExpiryApplication {}
