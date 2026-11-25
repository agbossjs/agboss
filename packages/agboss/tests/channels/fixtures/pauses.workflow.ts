import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { AutoApproveChannel } from "../../../src/testing/index.js";
import {
  Agent,
  Channel,
  ChannelOutcome,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  Observer,
  listOf,
  PauseRespondent,
  ChannelListener,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ChannelPauseAnswerNotTakenEvent,
  type ChannelPauseClosedEvent,
  type PauseClosedReason,
  type ChannelListenerAnswerNotTakenEvent,
  type PauseActor,
  type ChannelListenerClosedEvent,
  type ChannelListenerEventBase,
  type ChannelListenerOpenedEvent,
  type ChannelListenerReassignedEvent,
  type ExecutionResumeEvent,
  type ExecutionPauseEvent,
  type Tracked,
  Action,
  inline,
  ToolApproval,
  Ttl,
  ChannelSelector,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { minutes, days } from "../../../src/units/index.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { onStart, toAgent } from "../../helpers/flow.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #267 PR 2 — pauses and resume: a refund approval answered through its channel (a finance desk
 * that knows who answers: `PauseRespondent.Delegate`), an order confirmation answered by the thread's
 * owner (`PauseRespondent.Owner`), refunds of several orders at once (one branch per order,
 * each pausing), and a launch where one branch pauses while its sibling fails (`FailFast`). What
 * the channels were sent, the tools ran and the observers saw is in `seen` (reset per test).
 */

/** An ask a channel was sent: its pause's id and the order it is about. */
export interface SentAsk {
  readonly pauseId: string;
  readonly orderId: string;
  /** Set on the send of a reassignment (#946): who it is for. */
  readonly assignees?: readonly string[];
  /** The pause that send replaces (#946). */
  readonly replaces?: { readonly pauseId: string };
}

/** A close a channel was told (#940): the ask, why, who answered, and the frame it ran in. */
export interface SeenClosed extends SentAsk {
  readonly channel: string;
  readonly reason: PauseClosedReason;
  readonly deliveryId: string;
  readonly closedAt: string;
  readonly actor?: PauseActor | undefined;
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
  readonly type: "opened" | "closed" | "answer-not-taken" | "reassigned";
  readonly event: ChannelListenerEventBase &
    Partial<Pick<ChannelListenerClosedEvent, "actor" | "answer" | "closedAt">> & {
      readonly reason?: unknown;
    };
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
  /** The decision the desk gives at once to the send of a reassignment (#946); none: it waits for a reply. */
  decideReassigned?: unknown;
  /** The orders the desk refuses before it asks anyone (its `send` throws the error). */
  refusals?: ReadonlyMap<string, Error>;
  /** How many calls of every listener's hooks fail before one succeeds (#940). */
  listenerFailures?: number;
  /** What every channel's `onPauseClosed` throws after it recorded the close (#940). */
  closeFailure?: Error;
  /** What every channel's `onPauseClosed` waits for after it recorded the close (#940). */
  closeWait?: () => Promise<void>;
  /** What every channel's `onPauseAnswerNotTaken` waits for after it recorded the notice (#1131). */
  notTakenWait?: () => Promise<void>;
} = {};

export function resetPauses(): void {
  for (const list of Object.values(seen)) list.length = 0;
  delete hooks.beforeSendReturns;
  delete hooks.decideReassigned;
  delete hooks.refusals;
  delete hooks.listenerFailures;
  delete hooks.closeFailure;
  delete hooks.closeWait;
  delete hooks.notTakenWait;
}

/** What the fixture reads of a close, whatever the role types it. */
interface ClosedLike {
  readonly pauseId: string;
  readonly input: unknown;
  readonly reason: PauseClosedReason;
  readonly deliveryId: string;
  readonly closedAt: string;
  readonly actor?: PauseActor | undefined;
  readonly answer?: unknown;
}

/** What the fixture reads of an answer never applied. */
interface NotTakenLike {
  readonly pauseId: string;
  readonly input: unknown;
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
    orderId: orderIdIn(event.input),
    reason: event.reason,
    deliveryId: event.deliveryId,
    closedAt: event.closedAt,
    ...(event.actor === undefined ? {} : { actor: event.actor }),
    answer: event.answer,
    executionId: executionContext.executionId,
    tenantId: executionContext.tenant.tenantId,
    agent: executionContext.step.component.name,
  });
  await hooks.closeWait?.();
  if (hooks.closeFailure !== undefined) throw hooks.closeFailure;
}

/** Records an answer never applied, as the channel sees it. */
async function recordNotTaken(channel: string, event: NotTakenLike): Promise<void> {
  seen.notTaken.push({
    channel,
    pauseId: event.pauseId,
    orderId: orderIdIn(event.input),
    reason: event.reason,
    deliveryId: event.deliveryId,
    answer: event.answer,
  });
  await hooks.notTakenWait?.();
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

@ToolApproval({
  name: "refund-gate-tool-approval",
  description: "Approves refunds",
  input: RefundRequestDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class RefundDeskToolApproval {}

@ToolApproval({
  name: "order-confirmation-tool-approval",
  description: "The customer confirms an order",
  input: OrderConfirmationDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class OrderConfirmationToolApproval {}

/** What the finance desk's channels share: they post the ask (its `pauseId` is the reply key) and wait for the reply. */
abstract class FinanceDeskChannelBase {
  constructor(private readonly executionContext: ExecutionContext) {}

  async send(
    ask: ChannelAsk<RefundDeskToolApproval>,
  ): Promise<ChannelOutcome<RefundDeskToolApproval>> {
    this.executionContext.signal.throwIfAborted();
    const sent = {
      pauseId: ask.pauseId,
      orderId: orderIdIn(ask.input),
      ...(ask.assignees === undefined ? {} : { assignees: ask.assignees }),
      ...(ask.replaces === undefined ? {} : { replaces: ask.replaces }),
    };
    const refusal = hooks.refusals?.get(sent.orderId);
    if (refusal !== undefined) throw refusal;
    seen.asks.push(sent);
    await hooks.beforeSendReturns?.(sent);
    if (ask.replaces !== undefined && hooks.decideReassigned !== undefined)
      return ChannelOutcome.decided(hooks.decideReassigned as never);
    return ChannelOutcome.awaitReply();
  }

  onPauseClosed(event: ChannelPauseClosedEvent<RefundDeskToolApproval>): Promise<void> {
    return recordClose("finance-desk", this.executionContext, event);
  }

  onPauseAnswerNotTaken(
    event: ChannelPauseAnswerNotTakenEvent<RefundDeskToolApproval>,
  ): Promise<void> {
    return recordNotTaken("finance-desk", event);
  }
}

/** The finance desk. */
@Channel({
  name: "finance-desk-refund-approval-channel",
  description: "Asks the finance desk",
  deps: [ExecutionContext],
  target: RefundDeskToolApproval,
  ttl: days(1),
})
export class FinanceDeskRefundApprovalChannel extends FinanceDeskChannelBase {}

/** The finance desk's backup route: where a reassignment across channels goes (#1307d). */
@Channel({
  name: "finance-desk-backup-channel",
  description: "Asks the finance desk on the backup route",
  deps: [ExecutionContext],
  target: RefundDeskToolApproval,
  ttl: days(1),
})
export class FinanceDeskBackupChannel extends FinanceDeskChannelBase {}

/** New refund pauses go to the first desk; a reassignment names the backup one. */
@ChannelSelector({
  name: "refund-desk-selector",
  description: "Picks the first finance desk",
  target: RefundDeskToolApproval,
})
export class RefundDeskSelector {
  selectChannel(): typeof FinanceDeskRefundApprovalChannel {
    return FinanceDeskRefundApprovalChannel;
  }
}

/** Asks the customer in their own conversation. */
@Channel({
  name: "customer-order-confirmation-channel",
  description: "Asks the customer",
  deps: [ExecutionContext],
  target: OrderConfirmationToolApproval,
  ttl: days(1),
})
export class CustomerOrderConfirmationChannel {
  constructor(private readonly executionContext: ExecutionContext) {}

  onPauseClosed(event: ChannelPauseClosedEvent<OrderConfirmationToolApproval>): Promise<void> {
    return recordClose("customer", this.executionContext, event);
  }

  send(
    ask: ChannelAsk<OrderConfirmationToolApproval>,
  ): Promise<ChannelOutcome<OrderConfirmationToolApproval>> {
    seen.confirmations.push({ pauseId: ask.pauseId, orderId: orderIdIn(ask.input) });
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  approval: RefundDeskToolApproval,
  input: RefundRequestDto,
  output: RefundDoneDto,
})
export class RefundTool {
  execute({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    seen.refunds.push(orderId);
    return Promise.resolve({ orderId });
  }
}

/** The refund whose approval channel may take minutes: its hooks run under this `timeout` (#1131). */
@Tool({
  name: "slow-refund-tool",
  description: "Refunds an order, its approval channel is slow",
  approval: RefundDeskToolApproval,
  input: RefundRequestDto,
  output: RefundDoneDto,
  timeout: minutes(5),
})
export class SlowRefundTool {
  execute({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    seen.refunds.push(orderId);
    return Promise.resolve({ orderId });
  }
}

@Tool({
  name: "confirm-order-tool",
  description: "Confirms an order",
  approval: OrderConfirmationToolApproval,
  input: OrderConfirmationDto,
  output: OrderConfirmationDto,
})
export class ConfirmOrderTool {
  execute(input: OrderConfirmationDto): Promise<OrderConfirmationDto> {
    seen.confirmed.push(input.orderId);
    return Promise.resolve(input);
  }
}

/** Approves small refunds at once: its channel (`AutoApproveChannel`) decides, nothing pauses. */
@ToolApproval({
  name: "auto-refund-tool-approval",
  description: "Approves small refunds",
  input: RefundRequestDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(1),
})
export class AutoRefundToolApproval {}

/** The channel that decides at once for the small refunds (`AutoApproveChannel`). */
export const AutoRefundChannel = AutoApproveChannel.for(AutoRefundToolApproval);

/** Refunds at once: its channel decides (`AutoApproveChannel`), nothing pauses. */
@Tool({
  name: "auto-refund-tool",
  description: "Refunds a small order",
  approval: AutoRefundToolApproval,
  input: RefundRequestDto,
  output: RefundDoneDto,
})
export class AutoRefundTool {
  execute({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
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
@ChannelListener({ name: "audit-pause-listener", deps: [ExecutionContext] })
export class AuditPauseListener {
  constructor(private readonly executionContext: ExecutionContext) {}

  onPauseOpened(event: ChannelListenerOpenedEvent): Promise<void> {
    return hear("audit", this.executionContext, "opened", event);
  }

  onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    return hear("audit", this.executionContext, "closed", event);
  }

  onPauseAnswerNotTaken(event: ChannelListenerAnswerNotTakenEvent): Promise<void> {
    return hear("audit", this.executionContext, "answer-not-taken", event);
  }

  onPauseReassigned(event: ChannelListenerReassignedEvent): Promise<void> {
    return hear("audit", this.executionContext, "reassigned", event);
  }
}

/** A trusted component: it may answer a channel's pauses, so it sees their ids (D4). */
@ChannelListener({
  name: "trusted-pause-listener",
  includePauseIds: true,
  deps: [ExecutionContext],
})
export class TrustedPauseListener {
  constructor(private readonly executionContext: ExecutionContext) {}

  onPauseOpened(event: ChannelListenerOpenedEvent): Promise<void> {
    return hear("trusted", this.executionContext, "opened", event);
  }

  onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    return hear("trusted", this.executionContext, "closed", event);
  }

  onPauseReassigned(event: ChannelListenerReassignedEvent): Promise<void> {
    return hear("trusted", this.executionContext, "reassigned", event);
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

@Observer()
export class PauseLog {
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
  prompt: inline("Handle the request."),
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool, ConfirmOrderTool, AutoRefundTool, SlowRefundTool],
  input: { message: WorkflowStartTextDto },
})
export class DeskClerkAgent {}

@Workflow({
  name: "desk-workflow",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(DeskWorkflowStart).toAgent(DeskClerkAgent).toFinish(DeskWorkflowFinish)],
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
  prompt: inline("Refund the order."),
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

@Action({
  name: "batch-action",
  description: "What was refunded",
  input: { refunds: listOf(RefundDoneDto) },
  output: BatchSummaryDto,
})
export class BatchAction {
  async execute(input: {
    readonly refunds: readonly Tracked<RefundDoneDto>[];
  }): Promise<BatchSummaryDto> {
    return {
      text: input.refunds.map((refund) => refund.orderId).join(", "),
    };
  }
}

@WorkflowFinish({
  name: "batch-workflow-finish",
  description: "What was refunded",
  output: BatchSummaryDto,
})
export class BatchWorkflowFinish {}

@Workflow({
  name: "batch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(BatchWorkflowStart)
      .forEachItem(toAgent(BatchRefundAgent), { takeFirst: 5, maxConcurrency: 3 })
      .join()
      .toAction(BatchAction)
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
  prompt: inline("Refund the order."),
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundDoneDto,
})
export class AuditRefundAgent {}

@Agent({
  name: "audit-check-agent",
  description: "Checks the order",
  prompt: inline("Check the order."),
  model: "moonshotai/kimi-k2.6",
  input: { request: RefundRequestDto },
  output: BatchSummaryDto,
})
export class AuditCheckAgent {}

@Action({
  name: "audit-action",
  description: "The audit",
  input: { refund: RefundDoneDto, check: BatchSummaryDto },
  output: BatchSummaryDto,
})
export class AuditAction {
  async execute(input: {
    readonly refund: Tracked<RefundDoneDto>;
    readonly check: Tracked<BatchSummaryDto>;
  }): Promise<BatchSummaryDto> {
    return { text: `${input.refund.orderId}: ${input.check.text}` };
  }
}

@WorkflowFinish({
  name: "audit-workflow-finish",
  description: "The audit",
  output: BatchSummaryDto,
})
export class AuditWorkflowFinish {}

@Workflow({
  name: "audit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(AuditWorkflowStart)
      .inParallel([toAgent(AuditRefundAgent), toAgent(AuditCheckAgent)])
      .join()
      .toAction(AuditAction)
      .toFinish(AuditWorkflowFinish),
  ],
})
export class AuditWorkflow {}

@Application({
  name: "pauses-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow, BatchWorkflow, AuditWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    FinanceDeskBackupChannel,
    RefundDeskSelector,
    CustomerOrderConfirmationChannel,
    AutoRefundChannel,
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
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    AutoRefundChannel,
    SeenPausedExecutionRepository,
    RecordingLogger,
    AuditPauseListener,
  ],
  budgets: TEST_BUDGETS,
  retention: { pauseRecords: minutes(2) },
})
export class RetainedPausesApplication {}
