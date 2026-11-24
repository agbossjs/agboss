import { Application } from "../../../src/application/application.js";
import { ApplicationContext } from "../../../src/flow/context/application-context.js";
import { Channel, Injectable } from "../../../src/components/decorators.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  PauseExpiration,
  type PauseExpiryHandler,
} from "../../../src/channels/pause-expiration.js";
import type { ChannelPauseClosedEvent } from "../../../src/pause/notice-events.js";
import { Bool, Text } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import type {
  ExecutionEndEvent,
  ExecutionCancelEvent,
  ExecutionErrorEvent,
  ExecutionResumeEvent,
} from "../../../src/index.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import { Clock } from "../../../src/infrastructure/clock.js";
import { hours, minutes, seconds, days } from "../../../src/units/index.js";
import { RecordingLogger } from "../../helpers/log.js";
import { TEST_BUDGETS } from "./budgets.js";
import { onStart, toAction, toExternalTask } from "./paths.js";
import { Observer, ExternalTask } from "../../../src/index.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";

/**
 * #941 — a pause with a deadline: an order the manager approves within 24 hours; when nobody
 * answers, the director is asked on the `.onError(PauseExpiredError, …)` side path. What the
 * expiry handler was asked and what the channel heard is in `expiry`, reset per test.
 */

export class ExpiryOrderDto {
  @Text({ prompt: "the order" })
  orderId!: string;
}

export class ExpiryDecisionDto {
  @Bool({ prompt: "whether the order goes on" })
  approved!: boolean;

  @Text({ prompt: "why", optional: true })
  comment?: string;
}

export class ExpiryDoneDto {
  @Text()
  status!: string;
}

/** What `onPauseExpired` is made to do. */
export type ExpiryBehavior = (
  ask: ChannelAsk<ManagerExternalTask>,
) => PauseExpiration<ManagerExternalTask> | Promise<PauseExpiration<ManagerExternalTask>>;

export const expiry = {
  /** Every ask the manager's channel was sent, in order. */
  sent: [] as ChannelAsk<ManagerExternalTask>[],
  /** The instance each handler call ran on. */
  holders: [] as string[],
  /** Every ask the handler was called with, in order. */
  asked: [] as ChannelAsk<ManagerExternalTask>[],
  /** Every close the manager's channel was told. */
  closed: [] as ChannelPauseClosedEvent<ManagerExternalTask>[],
  /** The asks the owner's channel handler was called with. */
  ownerAsked: [] as ChannelAsk<OwnerExternalTask>[],
  /** What the owner's expiry handler does; none: `fail()`. */
  ownerBehavior: undefined as
    undefined | ((ask: ChannelAsk<OwnerExternalTask>) => PauseExpiration<OwnerExternalTask>),
  /** The director's asks. */
  directorAsked: [] as ChannelAsk<DirectorExternalTask>[],
  /** What the actions recorded. */
  recorded: [] as string[],
  /** The errors executions failed with, in order. */
  errors: [] as Error[],
  /** The executions cancelled, in order (#1341: a cancel is an outcome, not an error). */
  cancels: [] as ExecutionCancelEvent[],
  /** Every resume the observers heard of. */
  resumes: [] as ExecutionResumeEvent[],
  /** The executions that ended at a finish. */
  ended: [] as ExecutionEndEvent[],
  /** The orders whose slow escalation started, and ended. */
  slowStarted: [] as string[],
  slowEnded: [] as string[],
  /** The application's pause store. */
  stores: [] as InMemoryPausedExecutionRepository[],
  behavior: undefined as ExpiryBehavior | undefined,
  /** Runs inside the resume observer, between an expiry's record and its pass. */
  onResume: undefined as (() => Promise<void>) | undefined,
};

/** The pause store of the test (an instance's: they share it). */
export function expiryStore(): InMemoryPausedExecutionRepository {
  const [store] = expiry.stores;
  if (store === undefined) throw new Error("the application has not started");
  return store;
}

export function resetExpiry(): void {
  expiry.sent.length = 0;
  expiry.ownerAsked.length = 0;
  expiry.ownerBehavior = undefined;
  expiry.holders.length = 0;
  expiry.asked.length = 0;
  expiry.closed.length = 0;
  expiry.directorAsked.length = 0;
  expiry.recorded.length = 0;
  expiry.errors.length = 0;
  expiry.cancels.length = 0;
  expiry.resumes.length = 0;
  expiry.ended.length = 0;
  expiry.stores.length = 0;
  expiry.slowStarted.length = 0;
  expiry.slowEnded.length = 0;
  expiry.behavior = undefined;
  expiry.onResume = undefined;
}

@ExternalTask({
  name: "expiring-manager-external-task",
  description: "Asks a manager to approve an order within 24 hours",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class ManagerExternalTask {}

/** What every manager channel does: asked, told of a close, decides on expiry. */
export abstract class ManagerChannelBase implements PauseExpiryHandler<ManagerExternalTask> {
  constructor(private readonly context: ApplicationContext) {}

  send(ask: ChannelAsk<ManagerExternalTask>): Promise<ChannelOutcome<ManagerExternalTask>> {
    expiry.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  onPauseClosed(event: ChannelPauseClosedEvent<ManagerExternalTask>): Promise<void> {
    expiry.closed.push(event);
    return Promise.resolve();
  }

  onPauseExpired(
    ask: ChannelAsk<ManagerExternalTask>,
  ): PauseExpiration<ManagerExternalTask> | Promise<PauseExpiration<ManagerExternalTask>> {
    expiry.asked.push(ask);
    expiry.holders.push(this.context.instanceId);
    return expiry.behavior?.(ask) ?? PauseExpiration.fail();
  }
}

@Channel({
  name: "manager-expiry-channel",
  description: "Asks the manager",
  deps: [ApplicationContext],
  target: ManagerExternalTask,
  ttl: days(1),
})
export class ManagerChannel extends ManagerChannelBase {}

/** The manager with 4 hours instead of 24: the same channel, asked under its own target. */
@ExternalTask({
  name: "expiring-short-manager-external-task",
  description: "Asks a manager to approve an order within 4 hours",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
})
export class ShortManagerExternalTask {}

@Channel({
  name: "short-manager-expiry-channel",
  description: "Asks the manager, short",
  deps: [ApplicationContext],
  target: ShortManagerExternalTask,
  ttl: days(1),
})
export class ShortManagerChannel extends ManagerChannelBase {}

/** The manager with 3 seconds: the same channel, asked under its own target. */
@ExternalTask({
  name: "expiring-slow-manager-external-task",
  description: "Asks a manager to approve an order within 3 seconds",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: seconds(3),
})
export class SlowManagerExternalTask {}

@Channel({
  name: "slow-manager-expiry-channel",
  description: "Asks the manager, quick",
  deps: [ApplicationContext],
  target: SlowManagerExternalTask,
  ttl: days(1),
})
export class SlowManagerChannel extends ManagerChannelBase {}

@ExternalTask({
  name: "expiring-director-external-task",
  description: "Asks a director when the manager did not answer",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class DirectorExternalTask {}

/** What every director channel does: asked, it waits. */
export abstract class DirectorChannelBase {
  send(ask: ChannelAsk<DirectorExternalTask>): Promise<ChannelOutcome<DirectorExternalTask>> {
    expiry.directorAsked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({
  name: "director-expiry-channel",
  description: "Asks the director",
  target: DirectorExternalTask,
  ttl: days(1),
})
export class DirectorChannel extends DirectorChannelBase {}

/** The director with 1 hour instead of waiting on: the same channel, asked under its own target. */
@ExternalTask({
  name: "expiring-hour-director-external-task",
  description: "Asks a director within 1 hour",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(1),
})
export class HourDirectorExternalTask {}

@Channel({
  name: "hour-director-expiry-channel",
  description: "Asks the director, within the hour",
  target: HourDirectorExternalTask,
  ttl: days(1),
})
export class HourDirectorChannel extends DirectorChannelBase {}

/** A reviewer with no expiry handler and a 30 minutes deadline: its expiry fails the step. */
@ExternalTask({
  name: "expiring-reviewer-external-task",
  description: "Asks a reviewer within 30 minutes",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: minutes(30),
})
export class ReviewerExternalTask {}

@Channel({
  name: "reviewer-expiry-channel",
  description: "Asks the reviewer",
  target: ReviewerExternalTask,
  ttl: days(1),
})
export class ReviewerChannel {
  send(): Promise<ChannelOutcome<ReviewerExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({ name: "expiry-workflow-start", description: "An order", input: ExpiryOrderDto })
export class ExpiryWorkflowStart {}

@WorkflowFinish({ name: "expiry-workflow-finish", description: "Done", output: ExpiryDoneDto })
export class ExpiryWorkflowFinish {}

/** Records the answer the order goes on with. */
@Action({
  name: "record-expiry-action",
  description: "Records the decision",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
export class RecordExpiryAction implements ActionHandler<RecordExpiryAction> {
  execute({ order, decision }: InputOf<RecordExpiryAction>): Promise<OutputOf<RecordExpiryAction>> {
    const status = `${order.orderId}: ${decision.approved ? "approved" : "refused"}${decision.comment === undefined ? "" : ` (${decision.comment})`}`;
    expiry.recorded.push(status);
    return Promise.resolve({ status });
  }
}

/** Records the director's decision: the escalation's own step. */
@Action({
  name: "record-escalated-action",
  description: "Records the director's decision",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
export class RecordEscalatedAction implements ActionHandler<RecordEscalatedAction> {
  execute({
    order,
    decision,
  }: InputOf<RecordEscalatedAction>): Promise<OutputOf<RecordEscalatedAction>> {
    const status = `${order.orderId}: escalated, ${decision.approved ? "approved" : "refused"}`;
    expiry.recorded.push(status);
    return Promise.resolve({ status });
  }
}

/** The manager has 24 hours; a pause that expires asks the director. */
@Workflow({
  name: "expiry-workflow",
  version: "1.0.0",
  flow: [
    onStart(ExpiryWorkflowStart)
      .toExternalTask(ManagerExternalTask)
      .onError(
        PauseExpiredError,
        toExternalTask(DirectorExternalTask)
          .toAction(RecordEscalatedAction)
          .toFinish(ExpiryWorkflowFinish),
      )
      .toAction(RecordExpiryAction)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class ExpiryWorkflow {}

@WorkflowStart({
  name: "short-expiry-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
export class ShortExpiryWorkflowStart {}

/** The manager has 4 hours, not the 24 of the usual one: nothing catches the failure. */
@Workflow({
  name: "short-expiry-workflow",
  version: "1.0.0",
  flow: [
    onStart(ShortExpiryWorkflowStart)
      .toExternalTask(ShortManagerExternalTask)
      .toAction(RecordExpiryAction)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class ShortExpiryWorkflow {}

/** The escalation of a slow desk (#1071): a step of 30 s on the injected clock (a model call, a slow tool). */
@Action({
  name: "slow-escalation-action",
  description: "Escalates, slowly",
  input: { order: ExpiryOrderDto },
  output: ExpiryDoneDto,
  deps: [Clock],
})
export class SlowEscalationAction implements ActionHandler<SlowEscalationAction> {
  constructor(private readonly clock: Clock) {}

  async execute({ order }: InputOf<SlowEscalationAction>): Promise<OutputOf<SlowEscalationAction>> {
    expiry.slowStarted.push(order.orderId);
    await this.clock.sleep(seconds(30));
    expiry.slowEnded.push(order.orderId);
    return { status: `${order.orderId}: escalated slowly` };
  }
}

@WorkflowStart({
  name: "slow-expiry-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
export class SlowExpiryWorkflowStart {}

/** The manager has 3 seconds; the failure goes to a 30 s escalation step. */
@Workflow({
  name: "slow-expiry-workflow",
  version: "1.0.0",
  flow: [
    onStart(SlowExpiryWorkflowStart)
      .toExternalTask(SlowManagerExternalTask)
      .onError(PauseExpiredError, toAction(SlowEscalationAction)
        .toFinish(ExpiryWorkflowFinish))
      .toAction(RecordExpiryAction)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class SlowExpiryWorkflow {}

@WorkflowStart({ name: "reviewer-workflow-start", description: "An order", input: ExpiryOrderDto })
export class ReviewerWorkflowStart {}

/** A reviewer whose channel has no expiry handler: the expiry fails the run. */
@Workflow({
  name: "reviewer-workflow",
  version: "1.0.0",
  flow: [
    onStart(ReviewerWorkflowStart)
      .toExternalTask(ReviewerExternalTask)
      .toAction(RecordExpiryAction)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class ReviewerWorkflow {}

/** A question its thread's owner answers, within 10 minutes: what an A2A caller is asked. */
@ExternalTask({
  name: "expiring-owner-external-task",
  description: "Asks the order's owner within 10 minutes",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Owner,
  timeout: minutes(10),
})
export class OwnerExternalTask {}

@Channel({
  name: "owner-expiry-channel",
  description: "Waits for the owner",
  target: OwnerExternalTask,
  ttl: days(1),
})
export class OwnerChannel implements PauseExpiryHandler<OwnerExternalTask> {
  send(): Promise<ChannelOutcome<OwnerExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  onPauseExpired(
    ask: ChannelAsk<OwnerExternalTask>,
  ): PauseExpiration<OwnerExternalTask> | Promise<PauseExpiration<OwnerExternalTask>> {
    expiry.ownerAsked.push(ask);
    return expiry.ownerBehavior?.(ask) ?? PauseExpiration.fail();
  }
}

@WorkflowStart({ name: "owner-workflow-start", description: "An order", input: ExpiryOrderDto })
export class OwnerWorkflowStart {}

/** The owner has 10 minutes: what an A2A caller is asked and may be too late to answer. */
@Workflow({
  name: "owner-workflow",
  version: "1.0.0",
  flow: [
    onStart(OwnerWorkflowStart)
      .toExternalTask(OwnerExternalTask)
      .toAction(RecordExpiryAction)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class OwnerWorkflow {}

@Injectable()
export class ExpiryPausedExecutionRepository extends InMemoryPausedExecutionRepository {
  constructor() {
    super();
    expiry.stores.push(this);
  }
}

@WorkflowStart({ name: "plain-workflow-start", description: "An order", input: ExpiryOrderDto })
export class PlainWorkflowStart {}

/** The director has no deadline: a pause of a role with no `expiresIn` and a run with no deadline never expires. */
@Workflow({
  name: "plain-workflow",
  version: "1.0.0",
  flow: [
    onStart(PlainWorkflowStart)
      .toExternalTask(DirectorExternalTask)
      .toAction(RecordExpiryAction)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class PlainWorkflow {}

/** What the observers heard of each execution: how it ended and why it was resumed. */
@Observer()
export class ExpiryLog {
  onExecutionEnd(event: ExecutionEndEvent): void {
    expiry.ended.push(event);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    expiry.errors.push(event.error);
  }

  onExecutionCancel(event: ExecutionCancelEvent): void {
    expiry.cancels.push(event);
  }

  async onExecutionResume(event: ExecutionResumeEvent): Promise<void> {
    expiry.resumes.push(event);
    await expiry.onResume?.();
  }
}

@Application({
  name: "expiry-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    ExpiryWorkflow,
    ShortExpiryWorkflow,
    SlowExpiryWorkflow,
    ReviewerWorkflow,
    PlainWorkflow,
    OwnerWorkflow,
  ],
  budgets: TEST_BUDGETS,
  providers: [
    ManagerChannel,
    ShortManagerChannel,
    SlowManagerChannel,
    DirectorChannel,
    ReviewerChannel,
    OwnerChannel,
    ExpiryPausedExecutionRepository,
    RecordingLogger,
  ],
  observers: [ExpiryLog],
})
export class ExpiryApplication {}

/** The same desk on an instance that moves at most 4 steps at once (#1092). */
@Application({
  name: "capped-expiry-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ExpiryWorkflow, ShortExpiryWorkflow, SlowExpiryWorkflow, ReviewerWorkflow],
  budgets: TEST_BUDGETS,
  executionLimits: { maxConcurrentSteps: 4 },
  providers: [
    ManagerChannel,
    ShortManagerChannel,
    SlowManagerChannel,
    DirectorChannel,
    ReviewerChannel,
    ExpiryPausedExecutionRepository,
    RecordingLogger,
  ],
  observers: [ExpiryLog],
})
export class CappedExpiryApplication {}
