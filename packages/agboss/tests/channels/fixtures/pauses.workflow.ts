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
  PauseListener,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ChannelPauseAnswerNotTakenEvent,
  type ChannelPauseClosedEvent,
  type PauseClosedReason,
  type PauseListenerAnswerNotTakenEvent,
  type PauseListenerClosedEvent,
  type PauseListenerEventBase,
  type PauseListenerHandler,
  type PauseListenerOpenedEvent,
  type ExecutionResumeEvent,
  type ExecutionPauseEvent,
  type OnExecutionPause,
  type OnExecutionResume,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { minutes } from "../../../src/units/index.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
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

/** A close a channel was told (#940): the ask, why, who answered, and the frame it ran in. */
export interface SeenClosed extends SentAsk {
  readonly channel: string;
  readonly reason: PauseClosedReason;
  readonly deliveryId: string;
  readonly closedAt: string;
  readonly answeredBy?: string | undefined;
  readonly answer?: unknown;
  readonly executionId: string;
  readonly tenantId: string;
  readonly agent: string;
}

/** An answer a channel was told was never applied (#940). */
export interface SeenNotTaken extends SentAsk {
  readonly channel: string;
  readonly reason: PauseClosedReason;
  readonly deliveryId: string;
  readonly answer: unknown;
}

/** A notice a listener heard (#940): which, what it carried and where its hook ran. */
export interface Heard {
  readonly listener: string;
  readonly type: "opened" | "closed" | "answer-not-taken";
  readonly event: PauseListenerEventBase &
    Partial<Pick<PauseListenerClosedEvent, "reason" | "answeredBy" | "answer" | "closedAt">>;
  readonly executionId: string;
  readonly tenantId: string;
}

/** The order an ask's question is about (its tool call's arguments). */
const orderIdIn = (value: unknown): string =>
  /"orderId":"([^"]+)"/.exec(JSON.stringify(value))?.[1] ?? "?";

export const seen = {
  /** Every ask the refund desk was sent, in order (across the instances of a test). */
  asks: [] as SentAsk[],
  confirmations: [] as SentAsk[],
  /** Every close a channel was told (#940), in order, redeliveries included. */
  closed: [] as SeenClosed[],
  /** Every answer a channel was told was never applied (#940). */
  notTaken: [] as SeenNotTaken[],
  refunds: [] as string[],
  confirmed: [] as string[],
  pauses: [] as ExecutionPauseEvent[],
  resumes: [] as ExecutionResumeEvent[],
  /** Every notice a listener heard (#940), in order, redeliveries included. */
  heard: [] as Heard[],
  /** The application's pause store (one for every instance of a test). */
  repositories: [] as InMemoryPausedExecutionRepository[],
};

/** What the test does inside a `send` before it returns (a fast reply, a crash). */
export const hooks: {
  beforeSendReturns?: (ask: SentAsk) => Promise<void>;
  /** The orders the desk refuses before it asks anyone (its `send` throws the error). */
  refusals?: ReadonlyMap<string, Error>;
  /** How many calls of every listener's hooks fail before one succeeds (#940). */
  listenerFailures?: number;
  /** What every channel's `onPauseClosed` throws after it recorded the close (#940). */
  closeFailure?: Error;
  /** What every channel's `onPauseClosed` waits for after it recorded the close (#940). */
  closeWait?: () => Promise<void>;
} = {};

export function resetPauses(): void {
  for (const list of Object.values(seen)) list.length = 0;
  delete hooks.beforeSendReturns;
  delete hooks.refusals;
  delete hooks.listenerFailures;
  delete hooks.closeFailure;
  delete hooks.closeWait;
}

/** What the fixture reads of a close, whatever the role types it. */
interface ClosedLike {
  readonly pauseId: string;
  readonly value: unknown;
  readonly reason: PauseClosedReason;
  readonly deliveryId: string;
  readonly closedAt: string;
  readonly answeredBy?: string | undefined;
  readonly answer?: unknown;
}

/** What the fixture reads of an answer never applied. */
interface NotTakenLike {
  readonly pauseId: string;
  readonly value: unknown;
  readonly reason: PauseClosedReason;
  readonly deliveryId: string;
  readonly answer: unknown;
}

/** Records a close as the channel sees it — in the pause's frame — then waits or throws, if asked. */
async function recordClose(
  channel: string,
  executionContext: ExecutionContext,
  event: ClosedLike,
): Promise<void> {
  seen.closed.push({
    channel,
    pauseId: event.pauseId,
    orderId: orderIdIn(event.value),
    reason: event.reason,
    deliveryId: event.deliveryId,
    closedAt: event.closedAt,
    answeredBy: event.answeredBy,
    answer: event.answer,
    executionId: executionContext.executionId,
    tenantId: executionContext.tenant.tenantId,
    agent: executionContext.step.component.name,
  });
  await hooks.closeWait?.();
  if (hooks.closeFailure !== undefined) throw hooks.closeFailure;
}

/** Records an answer never applied, as the channel sees it. */
function recordNotTaken(channel: string, event: NotTakenLike): Promise<void> {
  seen.notTaken.push({
    channel,
    pauseId: event.pauseId,
    orderId: orderIdIn(event.value),
    reason: event.reason,
    deliveryId: event.deliveryId,
    answer: event.answer,
  });
  return Promise.resolve();
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
  answerer: PauseAnswerer.Channel,
})
export abstract class RefundApprovalChannel extends ChannelOf<RefundApprovalChannel> {}

@ChannelRole({
  name: "order-confirmation-channel",
  description: "The customer confirms an order",
  approves: OrderConfirmationDto,
  answerer: PauseAnswerer.ThreadOwner,
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

  override onPauseClosed(event: ChannelPauseClosedEvent<RefundApprovalChannel>): Promise<void> {
    return recordClose("finance-desk", this.executionContext, event);
  }

  override onPauseAnswerNotTaken(
    event: ChannelPauseAnswerNotTakenEvent<RefundApprovalChannel>,
  ): Promise<void> {
    return recordNotTaken("finance-desk", event);
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

  override onPauseClosed(event: ChannelPauseClosedEvent<OrderConfirmationChannel>): Promise<void> {
    return recordClose("customer", this.executionContext, event);
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

/** What a listener records of a notice: it hears opened, closed and never-applied answers. */
function hear(
  listener: string,
  executionContext: ExecutionContext,
  type: Heard["type"],
  event: Heard["event"],
): Promise<void> {
  seen.heard.push({
    listener,
    type,
    event,
    executionId: executionContext.executionId,
    tenantId: executionContext.tenant.tenantId,
  });
  if (hooks.listenerFailures !== undefined && hooks.listenerFailures > 0) {
    hooks.listenerFailures -= 1;
    return Promise.reject(new Error("the back office is down"));
  }
  return Promise.resolve();
}

/** A back office that follows every pause and never answers one. */
@PauseListener({ name: "audit-pause-listener", deps: [ExecutionContext] })
export class AuditPauseListener implements PauseListenerHandler {
  constructor(private readonly executionContext: ExecutionContext) {}

  onPauseOpened(event: PauseListenerOpenedEvent): Promise<void> {
    return hear("audit", this.executionContext, "opened", event);
  }

  onPauseClosed(event: PauseListenerClosedEvent): Promise<void> {
    return hear("audit", this.executionContext, "closed", event);
  }

  onPauseAnswerNotTaken(event: PauseListenerAnswerNotTakenEvent): Promise<void> {
    return hear("audit", this.executionContext, "answer-not-taken", event);
  }
}

/** A trusted component: it may answer a channel's pauses, so it sees their ids (D4). */
@PauseListener({
  name: "trusted-pause-listener",
  allowAnswering: true,
  deps: [ExecutionContext],
})
export class TrustedPauseListener implements PauseListenerHandler {
  constructor(private readonly executionContext: ExecutionContext) {}

  onPauseOpened(event: PauseListenerOpenedEvent): Promise<void> {
    return hear("trusted", this.executionContext, "opened", event);
  }

  onPauseClosed(event: PauseListenerClosedEvent): Promise<void> {
    return hear("trusted", this.executionContext, "closed", event);
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
    AuditPauseListener,
    TrustedPauseListener,
  ],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PausesApplication {}

/** The same application with a short retention: a set-aside notice and a closed pause go in minutes. */
@Application({
  name: "retained-pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
    RecordingLogger,
    AuditPauseListener,
  ],
  budgets: TEST_BUDGETS,
  retention: { pauseRecords: minutes(2) },
})
export class RetainedPausesApplication {}
