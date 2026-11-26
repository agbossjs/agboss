import { StepError } from "../../../src/core/error-families/step-errors.js";
import { Application } from "../../../src/application/application.js";
import {
  Agent,
  Channel,
  ChannelOutcome,
  PauseRespondent,
  Tool,
  type ChannelAsk,
  listOf,
  type Tracked,
  inline,
  ToolApproval,
  Ttl,
} from "../../../src/index.js";
import { PauseExpiration } from "../../../src/channels/pause-expiration.js";
import type { ExpiredContext } from "../../../src/channels/pause-contexts.js";
import { Text } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { hours, seconds, days } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  DirectorChannel,
  expiry,
  ExpiryDecisionDto,
  ExpiryLog,
  ExpiryOrderDto,
  ManagerChannel,
  ManagerExternalTask,
} from "./expiry.fixture.js";
import { onStart, toAction, toAgent } from "./paths.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #941 AC5 — an agent whose tool calls wait for an approval with a deadline: a refund approved by a
 * manager within 24 hours (the tool's own `expiresIn` of 4 hours for the urgent one), and a question
 * the agent asks the manager through its tool loop (#712). What the tools ran is in `refunds`.
 */

export class AgentRefundDto {
  @Text({ prompt: "the order to refund" })
  orderId!: string;
}

export class AgentRefundDoneDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

/** What the approval channel's expiry handler does with an expired ask. */
type ExpiryBehavior = ((ask: ExpiredContext<RefundApprovalToolApproval>) => Expiry) | undefined;
type Expiry = PauseExpiration<RefundApprovalToolApproval>;

export const agentExpiry = {
  /** The refunds the tools ran. */
  refunds: [] as string[],
  /** What the approval channel's expiry handler does; none: `fail()`. */
  behavior: undefined as ExpiryBehavior,
  /** The contexts the approval targets' handler was called with. */
  asked: [] as ExpiredContext<RefundApprovalToolApproval>[],
  /** What the gate tool waits for: replaced by each test. */
  gate: Promise.resolve(),
  /** The approval channel's sends. */
  sent: [] as ChannelAsk<RefundApprovalToolApproval>[],
};

export function resetAgentExpiry(): void {
  agentExpiry.refunds.length = 0;
  agentExpiry.asked.length = 0;
  agentExpiry.sent.length = 0;
  agentExpiry.gate = Promise.resolve();
  agentExpiry.behavior = undefined;
}

/** What every refund target does when its pause runs out: the test decides (none: `fail()`). */
abstract class RefundTargetBase {
  onExpired(
    ctx: ExpiredContext<RefundApprovalToolApproval>,
  ): PauseExpiration<RefundApprovalToolApproval> {
    agentExpiry.asked.push(ctx);
    return agentExpiry.behavior?.(ctx) ?? PauseExpiration.fail();
  }
}

@ToolApproval({
  name: "expiring-refund-approval-tool-approval",
  description: "A manager approves a refund within 24 hours",
  input: AgentRefundDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class RefundApprovalToolApproval extends RefundTargetBase {}

/** What every refund channel of this fixture does: asked, it waits. */
export abstract class RefundChannelBase {
  send(
    ask: ChannelAsk<RefundApprovalToolApproval>,
  ): Promise<ChannelOutcome<RefundApprovalToolApproval>> {
    agentExpiry.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({
  name: "refund-approval-expiry-channel",
  description: "Asks the manager",
  target: RefundApprovalToolApproval,
  ttl: days(1),
})
export class RefundDeskChannel extends RefundChannelBase {}

@Tool({
  name: "expiring-refund-tool",
  description: "Refunds an order once a manager approved it",
  approval: RefundApprovalToolApproval,
  input: AgentRefundDto,
  output: AgentRefundDoneDto,
})
export class ExpiringRefundTool {
  execute({ orderId }: AgentRefundDto): Promise<AgentRefundDoneDto> {
    agentExpiry.refunds.push(orderId);
    return Promise.resolve({ text: `refunded ${orderId}` });
  }
}

/** The same manager with 4 hours: the channel is the same, asked under its own target. */
@ToolApproval({
  name: "urgent-refund-tool-approval",
  description: "A manager approves a refund within 4 hours",
  input: AgentRefundDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
})
export class UrgentRefundToolApproval extends RefundTargetBase {}

@Channel({
  name: "urgent-refund-expiry-channel",
  description: "Asks the manager, urgently",
  target: UrgentRefundToolApproval,
  ttl: days(1),
})
export class UrgentRefundChannel extends RefundChannelBase {}

/** The same manager with 5 seconds. */
@ToolApproval({
  name: "quick-refund-tool-approval",
  description: "A manager approves a refund within 5 seconds",
  input: AgentRefundDto,
  respondent: PauseRespondent.Delegate,
  timeout: seconds(5),
})
export class QuickRefundToolApproval extends RefundTargetBase {}

@Channel({
  name: "quick-refund-expiry-channel",
  description: "Asks the manager, quickly",
  target: QuickRefundToolApproval,
  ttl: days(1),
})
export class QuickRefundChannel extends RefundChannelBase {}

@Tool({
  name: "urgent-refund-tool",
  description: "Refunds an order, the manager has 4 hours",
  approval: UrgentRefundToolApproval,
  input: AgentRefundDto,
  output: AgentRefundDoneDto,
})
export class UrgentRefundTool {
  execute({ orderId }: AgentRefundDto): Promise<AgentRefundDoneDto> {
    agentExpiry.refunds.push(orderId);
    return Promise.resolve({ text: `refunded ${orderId}` });
  }
}

@Tool({
  name: "quick-refund-tool",
  description: "Refunds an order, the manager has 5 seconds",
  approval: QuickRefundToolApproval,
  input: AgentRefundDto,
  output: AgentRefundDoneDto,
})
export class QuickRefundTool {
  execute({ orderId }: AgentRefundDto): Promise<AgentRefundDoneDto> {
    agentExpiry.refunds.push(orderId);
    return Promise.resolve({ text: `refunded ${orderId}` });
  }
}

@WorkflowStart({
  name: "agent-expiry-workflow-start",
  description: "A refund",
  input: AgentRefundDto,
})
export class AgentExpiryWorkflowStart {}

@WorkflowFinish({
  name: "agent-expiry-workflow-finish",
  description: "What was done",
  output: AgentRefundDoneDto,
})
export class AgentExpiryWorkflowFinish {}

@Agent({
  name: "expiry-refund-agent",
  description: "Refunds an order, asks a manager",
  prompt: inline("Refund the order."),
  model: "moonshotai/kimi-k2.6",
  tools: [ExpiringRefundTool, UrgentRefundTool, QuickRefundTool, ManagerExternalTask],
  input: { request: AgentRefundDto },
  output: AgentRefundDoneDto,
})
export class ExpiryRefundAgent {}

/** The escalation: a person takes the order over. */
@Action({
  name: "escalate-refund-action",
  description: "Hands the refund to a person",
  input: { request: AgentRefundDto },
  output: AgentRefundDoneDto,
})
export class EscalateRefundAction implements ActionHandler<EscalateRefundAction> {
  execute({ request }: InputOf<EscalateRefundAction>): Promise<OutputOf<EscalateRefundAction>> {
    expiry.recorded.push(`escalated ${request.orderId}`);
    return Promise.resolve({ text: `escalated ${request.orderId}` });
  }
}

@Workflow({
  name: "agent-expiry-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(AgentExpiryWorkflowStart)
      .toAgent(ExpiryRefundAgent)
      .onError(
        StepError.PauseExpired,
        toAction(EscalateRefundAction).toFinish(AgentExpiryWorkflowFinish),
      )
      .toFinish(AgentExpiryWorkflowFinish),
  ],
})
export class AgentExpiryWorkflow {}

@WorkflowStart({
  name: "agent-bare-workflow-start",
  description: "A refund",
  input: AgentRefundDto,
})
export class AgentBareWorkflowStart {}

/** Nothing catches the failure: the run fails with it. */
@Workflow({
  name: "agent-bare-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(AgentBareWorkflowStart).toAgent(ExpiryRefundAgent).toFinish(AgentExpiryWorkflowFinish),
  ],
})
export class AgentBareWorkflow {}

// ── a batch: one agent per order, each pausing (I6: two pauses expire in one pass) ──

@WorkflowStart({
  name: "agent-batch-workflow-start",
  description: "The orders to refund",
  input: listOf(AgentRefundDto),
})
export class AgentBatchWorkflowStart {}

@Agent({
  name: "expiry-batch-refund-agent",
  description: "Refunds one order",
  prompt: inline("Refund the order."),
  model: "moonshotai/kimi-k2.6",
  tools: [ExpiringRefundTool],
  input: { request: AgentRefundDto },
  output: AgentRefundDoneDto,
})
export class ExpiryBatchRefundAgent {}

export class AgentBatchSummaryDto {
  @Text({ prompt: "what was refunded" })
  text!: string;
}

@Action({
  name: "agent-batch-action",
  description: "What was refunded",
  input: { refunds: listOf(AgentRefundDoneDto) },
  output: AgentBatchSummaryDto,
})
export class AgentBatchAction {
  async execute(input: {
    readonly refunds: readonly Tracked<AgentRefundDoneDto>[];
  }): Promise<AgentBatchSummaryDto> {
    const texts = input.refunds.map((refund) => refund.text);
    return { text: texts.join(", ") };
  }
}

@WorkflowFinish({
  name: "agent-batch-workflow-finish",
  description: "What was refunded",
  output: AgentBatchSummaryDto,
})
export class AgentBatchWorkflowFinish {}

@Workflow({
  name: "agent-batch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(AgentBatchWorkflowStart)
      .forEachItem(toAgent(ExpiryBatchRefundAgent), { takeFirst: 5, maxConcurrency: 3 })
      .join()
      .toAction(AgentBatchAction)
      .toFinish(AgentBatchWorkflowFinish),
  ],
})
export class AgentBatchWorkflow {}

// ── a branch pauses while its sibling still runs (I6) ──

export class GateDto {
  @Text({ prompt: "what to hold" })
  what!: string;
}

/** Holds its call until the test opens the gate: a sibling branch that still runs. */
@Tool({
  name: "gate-tool",
  description: "Waits for the gate",
  input: GateDto,
  output: GateDto,
})
export class GateTool {
  async execute(input: GateDto): Promise<GateDto> {
    await agentExpiry.gate;
    return input;
  }
}

@Agent({
  name: "expiry-hold-agent",
  description: "Holds at the gate",
  prompt: inline("Hold."),
  model: "moonshotai/kimi-k2.6",
  tools: [GateTool],
  input: { request: AgentRefundDto },
  output: GateDto,
})
export class ExpiryHoldAgent {}

@WorkflowStart({
  name: "agent-gated-workflow-start",
  description: "An order",
  input: AgentRefundDto,
})
export class AgentGatedWorkflowStart {}

@Action({
  name: "agent-gated-action",
  description: "Both done",
  input: { refund: AgentRefundDoneDto, hold: GateDto },
  output: AgentRefundDoneDto,
})
export class AgentGatedAction {
  async execute(input: {
    readonly refund: Tracked<AgentRefundDoneDto>;
  }): Promise<AgentRefundDoneDto> {
    return { text: input.refund.text };
  }
}

@WorkflowFinish({
  name: "agent-gated-workflow-finish",
  description: "Both done",
  output: AgentRefundDoneDto,
})
export class AgentGatedWorkflowFinish {}

@Workflow({
  name: "agent-gated-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(AgentGatedWorkflowStart)
      .inParallel([toAgent(ExpiryRefundAgent), toAgent(ExpiryHoldAgent)])
      .join()
      .toAction(AgentGatedAction)
      .toFinish(AgentGatedWorkflowFinish),
  ],
})
export class AgentGatedWorkflow {}

@Application({
  name: "agent-expiry-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [AgentExpiryWorkflow, AgentBareWorkflow, AgentBatchWorkflow, AgentGatedWorkflow],
  budgets: TEST_BUDGETS,
  providers: [
    RefundDeskChannel,
    UrgentRefundChannel,
    QuickRefundChannel,
    ManagerChannel,
    DirectorChannel,
  ],
  observers: [ExpiryLog],
})
export class AgentExpiryApplication {}

export { ExpiryDecisionDto, ExpiryOrderDto };
