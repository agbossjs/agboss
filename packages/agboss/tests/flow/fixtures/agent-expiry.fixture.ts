import { Application } from "../../../src/application/application.js";
import {
  Agent,
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  PauseAnswerer,
  Tool,
  type ChannelAsk,
  listOf,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import {
  PauseExpiration,
  type PauseExpiryHandler,
} from "../../../src/channels/pause-expiration.js";
import { Text } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import { hours, seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  DirectorChannel,
  expiry,
  ExpiryDecisionDto,
  ExpiryLog,
  ExpiryOrderDto,
  ManagerChannel,
  ManagerQuestion,
} from "./expiry.fixture.js";
import { start, toAction } from "./paths.js";

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

export const agentExpiry = {
  /** The refunds the tools ran. */
  refunds: [] as string[],
  /** What the approval channel's expiry handler does; none: `fail()`. */
  behavior: undefined as
    undefined | ((ask: ChannelAsk<RefundApprovalRole>) => PauseExpiration<RefundApprovalRole>),
  /** The asks the approval channel's handler was called with. */
  asked: [] as ChannelAsk<RefundApprovalRole>[],
  /** What the gate tool waits for: replaced by each test. */
  gate: Promise.resolve(),
  /** The approval channel's sends. */
  sent: [] as ChannelAsk<RefundApprovalRole>[],
};

export function resetAgentExpiry(): void {
  agentExpiry.refunds.length = 0;
  agentExpiry.asked.length = 0;
  agentExpiry.sent.length = 0;
  agentExpiry.gate = Promise.resolve();
  agentExpiry.behavior = undefined;
}

@ChannelRole({
  name: "expiring-refund-approval",
  description: "A manager approves a refund within 24 hours",
  approves: AgentRefundDto,
  answerer: PauseAnswerer.Channel,
  expiresIn: hours(24),
})
export abstract class RefundApprovalRole extends ChannelOf<RefundApprovalRole> {}

@Channel({ name: "refund-approval-expiry-channel", description: "Asks the manager" })
export class RefundApprovalChannel
  extends RefundApprovalRole
  implements PauseExpiryHandler<RefundApprovalRole>
{
  send(ask: ChannelAsk<RefundApprovalRole>): Promise<ChannelOutcome<RefundApprovalRole>> {
    agentExpiry.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  onPauseExpired(ask: ChannelAsk<RefundApprovalRole>): PauseExpiration<RefundApprovalRole> {
    agentExpiry.asked.push(ask);
    return agentExpiry.behavior?.(ask) ?? PauseExpiration.fail();
  }
}

@Tool({
  name: "expiring-refund-tool",
  description: "Refunds an order once a manager approved it",
  channel: RefundApprovalRole,
  input: AgentRefundDto,
  output: AgentRefundDoneDto,
})
export class ExpiringRefundTool implements ToolHandler<AgentRefundDto, AgentRefundDoneDto> {
  run({ orderId }: AgentRefundDto): Promise<AgentRefundDoneDto> {
    agentExpiry.refunds.push(orderId);
    return Promise.resolve({ text: `refunded ${orderId}` });
  }
}

@Tool({
  name: "urgent-refund-tool",
  description: "Refunds an order, the manager has 4 hours",
  channel: RefundApprovalRole,
  expiresIn: hours(4),
  input: AgentRefundDto,
  output: AgentRefundDoneDto,
})
export class UrgentRefundTool implements ToolHandler<AgentRefundDto, AgentRefundDoneDto> {
  run({ orderId }: AgentRefundDto): Promise<AgentRefundDoneDto> {
    agentExpiry.refunds.push(orderId);
    return Promise.resolve({ text: `refunded ${orderId}` });
  }
}

@Tool({
  name: "quick-refund-tool",
  description: "Refunds an order, the manager has 5 seconds",
  channel: RefundApprovalRole,
  expiresIn: seconds(5),
  input: AgentRefundDto,
  output: AgentRefundDoneDto,
})
export class QuickRefundTool implements ToolHandler<AgentRefundDto, AgentRefundDoneDto> {
  run({ orderId }: AgentRefundDto): Promise<AgentRefundDoneDto> {
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
  prompt: "Refund the order.",
  model: "moonshotai/kimi-k2.6",
  tools: [ExpiringRefundTool, UrgentRefundTool, QuickRefundTool, ManagerQuestion],
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
    expiry.recorded.push(`escalated ${request.value.orderId}`);
    return Promise.resolve({ text: `escalated ${request.value.orderId}` });
  }
}

@Workflow({
  name: "agent-expiry-workflow",
  version: "1.0.0",
  flow: [
    start(AgentExpiryWorkflowStart)
      .returns(AgentRefundDto)
      .toAgent(ExpiryRefundAgent)
      .onError(
        PauseExpiredError,
        toAction(EscalateRefundAction)
          .returns(AgentRefundDoneDto)
          .toFinish(AgentExpiryWorkflowFinish),
      )
      .returns(AgentRefundDoneDto)
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
  flow: [
    start(AgentBareWorkflowStart)
      .returns(AgentRefundDto)
      .toAgent(ExpiryRefundAgent)
      .returns(AgentRefundDoneDto)
      .toFinish(AgentExpiryWorkflowFinish),
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
  prompt: "Refund the order.",
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

@WorkflowFinish({
  name: "agent-batch-workflow-finish",
  description: "What was refunded",
  input: { refunds: listOf(AgentRefundDoneDto) },
  output: AgentBatchSummaryDto,
})
export class AgentBatchWorkflowFinish {
  finish(input: {
    readonly refunds: readonly Produced<AgentRefundDoneDto, unknown>[];
  }): AgentBatchSummaryDto {
    const texts = input.refunds.map((refund) => refund.value.text);
    return { text: texts.join(", ") };
  }
}

@Workflow({
  name: "agent-batch-workflow",
  version: "1.0.0",
  maxSteps: 20,
  flow: [
    start(AgentBatchWorkflowStart)
      .returns(listOf(AgentRefundDto))
      .toParallelAgents(ExpiryBatchRefundAgent, { maxConcurrency: 3, maxItems: 5 })
      .join()
      .returns(listOf(AgentRefundDoneDto))
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
export class GateTool implements ToolHandler<GateDto, GateDto> {
  async run(input: GateDto): Promise<GateDto> {
    await agentExpiry.gate;
    return input;
  }
}

@Agent({
  name: "expiry-hold-agent",
  description: "Holds at the gate",
  prompt: "Hold.",
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

@WorkflowFinish({
  name: "agent-gated-workflow-finish",
  description: "Both done",
  input: { refund: AgentRefundDoneDto, hold: GateDto },
  output: AgentRefundDoneDto,
})
export class AgentGatedWorkflowFinish {
  finish(input: { readonly refund: Produced<AgentRefundDoneDto, unknown> }): AgentRefundDoneDto {
    return { text: input.refund.value.text };
  }
}

@Workflow({
  name: "agent-gated-workflow",
  version: "1.0.0",
  flow: [
    start(AgentGatedWorkflowStart)
      .returns(AgentRefundDto)
      .toParallelAgents(ExpiryRefundAgent, ExpiryHoldAgent)
      .join()
      .returns(AgentRefundDoneDto)
      .returns(GateDto)
      .toFinish(AgentGatedWorkflowFinish),
  ],
})
export class AgentGatedWorkflow {}

@Application({
  name: "agent-expiry-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AgentExpiryWorkflow, AgentBareWorkflow, AgentBatchWorkflow, AgentGatedWorkflow],
  budgets: TEST_BUDGETS,
  providers: [RefundApprovalChannel, ManagerChannel, DirectorChannel],
  observers: [ExpiryLog],
})
export class AgentExpiryApplication {}

export { ExpiryDecisionDto, ExpiryOrderDto };
