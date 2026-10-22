import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  AutoApproveChannel,
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  listOf,
  PauseAnswerer,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ChannelWithdrawal,
  type PauseCancellation,
  type ExecutionResumeEvent,
  type ExecutionPauseEvent,
  type OnExecutionPause,
  type OnExecutionResume,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { start } from "../../helpers/flow.js";

/**
 * #267 PR 2 — pauses and resume: a refund approval answered through its channel (a finance desk
 * that knows who answers: `PauseAnswerer.Channel`), an order confirmation answered by the thread's
 * owner (`PauseAnswerer.ThreadOwner`), refunds of several orders at once (one branch per order,
 * each pausing), and a launch where one branch pauses while its sibling fails (`FailFast`). What
 * the channels were sent, the tools ran and the observers saw is in `seen` (reset per test).
 */

/** An ask a channel was sent: its pause's id and the order it is about. */
export interface SentAsk {
  readonly pauseId: string;
  readonly orderId: string;
}

/** A question a channel took back (#337): the ask, why, and the frame it ran in. */
export interface SeenWithdrawal extends SentAsk {
  readonly channel: string;
  readonly resolution: PauseCancellation;
  readonly executionId: string;
  readonly tenantId: string;
  readonly agent: string;
}

/** The order an ask's question is about (its tool call's arguments). */
const orderIdIn = (value: unknown): string =>
  /"orderId":"([^"]+)"/.exec(JSON.stringify(value))?.[1] ?? "?";

export const seen = {
  /** Every ask the refund desk was sent, in order (across the instances of a test). */
  asks: [] as SentAsk[],
  confirmations: [] as SentAsk[],
  /** Every question a channel took back (#337), in order. */
  withdrawals: [] as SeenWithdrawal[],
  refunds: [] as string[],
  confirmed: [] as string[],
  pauses: [] as ExecutionPauseEvent[],
  resumes: [] as ExecutionResumeEvent[],
  /** The application's pause store (one for every instance of a test). */
  repositories: [] as InMemoryPausedExecutionRepository[],
};

/** What the test does inside a `send` before it returns (a fast reply, a crash). */
export const hooks: {
  beforeSendReturns?: (ask: SentAsk) => Promise<void>;
  /** The orders the desk refuses before it asks anyone (its `send` throws the error). */
  refusals?: ReadonlyMap<string, Error>;
  /** What every channel's `withdraw` throws after it recorded the withdrawal (#337). */
  withdrawFailure?: Error;
  /** What every channel's `withdraw` waits for after it recorded the withdrawal (#337). */
  withdrawWait?: () => Promise<void>;
} = {};

export function resetPauses(): void {
  for (const list of Object.values(seen)) list.length = 0;
  delete hooks.beforeSendReturns;
  delete hooks.refusals;
  delete hooks.withdrawFailure;
  delete hooks.withdrawWait;
}

/** Records a withdrawal as the channel sees it — in the pause's frame — then throws, if asked. */
async function recordWithdrawal(
  channel: string,
  executionContext: ExecutionContext,
  withdrawal: {
    readonly pauseId: string;
    readonly value: unknown;
    readonly resolution: PauseCancellation;
  },
): Promise<void> {
  seen.withdrawals.push({
    channel,
    pauseId: withdrawal.pauseId,
    orderId: orderIdIn(withdrawal.value),
    resolution: withdrawal.resolution,
    executionId: executionContext.executionId,
    tenantId: executionContext.tenant.tenantId,
    agent: executionContext.step.component.name,
  });
  await hooks.withdrawWait?.();
  if (hooks.withdrawFailure !== undefined) throw hooks.withdrawFailure;
}

export class RefundRequestDto {
  @Text({ prompt: "the order to refund" })
  orderId!: string;
}

export class RefundDoneDto {
  @Text({ prompt: "the refunded order" })
  orderId!: string;
}

export class OrderConfirmationDto {
  @Text({ prompt: "the order to confirm" })
  orderId!: string;
}

@ChannelRole({
  name: "refund-approval-channel",
  description: "Approves refunds",
  approves: RefundRequestDto,
  answeredBy: PauseAnswerer.Channel,
})
export abstract class RefundApprovalChannel extends ChannelOf<RefundApprovalChannel> {}

@ChannelRole({
  name: "order-confirmation-channel",
  description: "The customer confirms an order",
  approves: OrderConfirmationDto,
  answeredBy: PauseAnswerer.ThreadOwner,
})
export abstract class OrderConfirmationChannel extends ChannelOf<OrderConfirmationChannel> {}

/** The finance desk: posts the ask (its `pauseId` is the reply key) and waits for the reply. */
@Channel({
  name: "finance-desk-refund-approval-channel",
  description: "Asks the finance desk",
  deps: [ExecutionContext],
})
export class FinanceDeskRefundApprovalChannel extends RefundApprovalChannel {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  async send(
    ask: ChannelAsk<RefundApprovalChannel>,
  ): Promise<ChannelOutcome<RefundApprovalChannel>> {
    this.executionContext.signal.throwIfAborted();
    const sent = { pauseId: ask.pauseId, orderId: orderIdIn(ask.value) };
    const refusal = hooks.refusals?.get(sent.orderId);
    if (refusal !== undefined) throw refusal;
    seen.asks.push(sent);
    await hooks.beforeSendReturns?.(sent);
    return ChannelOutcome.awaitReply();
  }

  override withdraw(withdrawal: ChannelWithdrawal<RefundApprovalChannel>): Promise<void> {
    return recordWithdrawal("finance-desk", this.executionContext, withdrawal);
  }
}

/** Asks the customer in their own conversation. */
@Channel({
  name: "customer-order-confirmation-channel",
  description: "Asks the customer",
  deps: [ExecutionContext],
})
export class CustomerOrderConfirmationChannel extends OrderConfirmationChannel {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  override withdraw(withdrawal: ChannelWithdrawal<OrderConfirmationChannel>): Promise<void> {
    return recordWithdrawal("customer", this.executionContext, withdrawal);
  }

  send(
    ask: ChannelAsk<OrderConfirmationChannel>,
  ): Promise<ChannelOutcome<OrderConfirmationChannel>> {
    seen.confirmations.push({ pauseId: ask.pauseId, orderId: orderIdIn(ask.value) });
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  channel: RefundApprovalChannel,
  input: RefundRequestDto,
  output: RefundDoneDto,
})
export class RefundTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    seen.refunds.push(orderId);
    return Promise.resolve({ orderId });
  }
}

@Tool({
  name: "confirm-order-tool",
  description: "Confirms an order",
  channel: OrderConfirmationChannel,
  input: OrderConfirmationDto,
  output: OrderConfirmationDto,
})
export class ConfirmOrderTool implements ToolHandler<OrderConfirmationDto, OrderConfirmationDto> {
  run(input: OrderConfirmationDto): Promise<OrderConfirmationDto> {
    seen.confirmed.push(input.orderId);
    return Promise.resolve(input);
  }
}

/** Refunds at once: its channel decides (`AutoApproveChannel`), nothing pauses. */
@Tool({
  name: "auto-refund-tool",
  description: "Refunds a small order",
  channel: AutoApproveChannel,
  input: RefundRequestDto,
  output: RefundDoneDto,
})
export class AutoRefundTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    seen.refunds.push(orderId);
    return Promise.resolve({ orderId });
  }
}

/** The in-memory pause store, seen by the tests (an instance shares it with the others). */
@Injectable()
export class SeenPausedExecutionRepository extends InMemoryPausedExecutionRepository {
  constructor() {
    super();
    seen.repositories.push(this);
  }
}

/** The pause store of the test (the first instance's — the others reuse it). */
export function pauseStore(): InMemoryPausedExecutionRepository {
  const [store] = seen.repositories;
  if (store === undefined) throw new Error("the application has not started");
  return store;
}

@Injectable()
export class PauseLog implements OnExecutionPause, OnExecutionResume {
  onExecutionPause(event: ExecutionPauseEvent): void {
    seen.pauses.push(event);
  }
  onExecutionResume(event: ExecutionResumeEvent): void {
    seen.resumes.push(event);
  }
}

// ── one agent, one tool call ──

@WorkflowStart({
  name: "desk-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class DeskWorkflowStart {}

@WorkflowFinish({
  name: "desk-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class DeskWorkflowFinish {}

@Agent({
  name: "desk-clerk-agent",
  description: "Refunds, confirms orders",
  prompt: "Handle the request.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool, ConfirmOrderTool, AutoRefundTool],
  input: { message: WorkflowStartTextDto },
})
export class DeskClerkAgent {}

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    start(DeskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DeskClerkAgent)
      .toFinish(DeskWorkflowFinish),
  ],
})
export class DeskWorkflow {}

// ── one branch per order, each pausing ──

@WorkflowStart({
  name: "batch-workflow-start",
  description: "The orders to refund",
  input: listOf(RefundRequestDto),
})
export class BatchWorkflowStart {}

@Agent({
  name: "batch-refund-agent",
  description: "Refunds one order",
  prompt: "Refund the order.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundDoneDto,
})
export class BatchRefundAgent {}

export class BatchSummaryDto {
  @Text({ prompt: "what was refunded" })
  text!: string;
}

@WorkflowFinish({
  name: "batch-workflow-finish",
  description: "What was refunded",
  input: { refunds: listOf(RefundDoneDto) },
  output: BatchSummaryDto,
})
export class BatchWorkflowFinish {
  finish(input: {
    readonly refunds: readonly Produced<RefundDoneDto, unknown>[];
  }): BatchSummaryDto {
    return {
      text: input.refunds
        .map((refund) => refund.value.orderId)
        .join(", "),
    };
  }
}

@Workflow({
  name: "batch-workflow",
  version: "1.0.0",
  maxSteps: 20,
  flow: [
    start(BatchWorkflowStart)
      .returns(listOf(RefundRequestDto))
      .toParallelAgents(BatchRefundAgent, { maxConcurrency: 3, maxItems: 5 })
      .join()
      .returns(listOf(RefundDoneDto))
      .toFinish(BatchWorkflowFinish),
  ],
})
export class BatchWorkflow {}

// ── a branch pauses while its sibling fails ──

@WorkflowStart({ name: "audit-workflow-start", description: "An order", input: RefundRequestDto })
export class AuditWorkflowStart {}

@Agent({
  name: "audit-refund-agent",
  description: "Refunds the order",
  prompt: "Refund the order.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundDoneDto,
})
export class AuditRefundAgent {}

@Agent({
  name: "audit-check-agent",
  description: "Checks the order",
  prompt: "Check the order.",
  model: "moonshotai/kimi-k2.6",
  input: { request: RefundRequestDto },
  output: BatchSummaryDto,
})
export class AuditCheckAgent {}

@WorkflowFinish({
  name: "audit-workflow-finish",
  description: "The audit",
  input: { refund: RefundDoneDto, check: BatchSummaryDto },
  output: BatchSummaryDto,
})
export class AuditWorkflowFinish {
  finish(input: {
    readonly refund: Produced<RefundDoneDto, unknown>;
    readonly check: Produced<BatchSummaryDto, unknown>;
  }): BatchSummaryDto {
    return { text: `${input.refund.value.orderId}: ${input.check.value.text}` };
  }
}

@Workflow({
  name: "audit-workflow",
  version: "1.0.0",
  flow: [
    start(AuditWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(AuditRefundAgent, AuditCheckAgent)
      .join()
      .returns(RefundDoneDto)
      .returns(BatchSummaryDto)
      .toFinish(AuditWorkflowFinish),
  ],
})
export class AuditWorkflow {}

@Application({
  name: "pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow, BatchWorkflow, AuditWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
    RecordingLogger,
  ],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PausesApplication {}
