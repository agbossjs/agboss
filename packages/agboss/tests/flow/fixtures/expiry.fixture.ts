import { Application } from "../../../src/application/application.js";
import { ApplicationContext } from "../../../src/flow/context/application-context.js";
import { Channel, Injectable } from "../../../src/components/decorators.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import {
  PauseExpiration,
  type PauseExpiryHandler,
} from "../../../src/channels/pause-expiration.js";
import type { ChannelPauseClosedEvent } from "../../../src/pause/notice-events.js";
import { Flag, Text } from "../../../src/dto/index.js";
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
  ExecutionErrorEvent,
  ExecutionResumeEvent,
  OnExecutionEnd,
  OnExecutionError,
  OnExecutionResume,
} from "../../../src/index.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import { hours, minutes } from "../../../src/units/index.js";
import { RecordingLogger } from "../../helpers/log.js";
import { TEST_BUDGETS } from "./budgets.js";
import { start, toQuestion } from "./paths.js";

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
  @Flag({ prompt: "whether the order goes on" })
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
  ask: ChannelAsk<ManagerQuestion>,
) => PauseExpiration<ManagerQuestion> | Promise<PauseExpiration<ManagerQuestion>>;

export const expiry = {
  /** Every ask the manager's channel was sent, in order. */
  sent: [] as ChannelAsk<ManagerQuestion>[],
  /** The instance each handler call ran on. */
  holders: [] as string[],
  /** Every ask the handler was called with, in order. */
  asked: [] as ChannelAsk<ManagerQuestion>[],
  /** Every close the manager's channel was told. */
  closed: [] as ChannelPauseClosedEvent<ManagerQuestion>[],
  /** The asks the owner's channel handler was called with. */
  ownerAsked: [] as ChannelAsk<OwnerQuestion>[],
  /** What the owner's expiry handler does; none: `fail()`. */
  ownerBehavior: undefined as
    undefined | ((ask: ChannelAsk<OwnerQuestion>) => PauseExpiration<OwnerQuestion>),
  /** The director's asks. */
  directorAsked: [] as ChannelAsk<DirectorQuestion>[],
  /** What the actions recorded. */
  recorded: [] as string[],
  /** The errors executions failed with, in order. */
  errors: [] as Error[],
  /** Every resume the observers heard of. */
  resumes: [] as ExecutionResumeEvent[],
  /** The executions that ended at a finish. */
  ended: [] as ExecutionEndEvent[],
  /** The application's pause store. */
  stores: [] as InMemoryPausedExecutionRepository[],
  behavior: undefined as ExpiryBehavior | undefined,
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
  expiry.resumes.length = 0;
  expiry.ended.length = 0;
  expiry.stores.length = 0;
  expiry.behavior = undefined;
}

@ChannelRole({
  name: "expiring-manager-question",
  description: "Asks a manager to approve an order within 24 hours",
  ask: ExpiryOrderDto,
  answer: ExpiryDecisionDto,
  answerer: PauseAnswerer.Channel,
  expiresIn: hours(24),
})
export abstract class ManagerQuestion extends ChannelOf<ManagerQuestion> {}

@Channel({
  name: "manager-expiry-channel",
  description: "Asks the manager",
  deps: [ApplicationContext],
})
export class ManagerChannel extends ManagerQuestion implements PauseExpiryHandler<ManagerQuestion> {
  constructor(private readonly context: ApplicationContext) {
    super();
  }

  send(ask: ChannelAsk<ManagerQuestion>): Promise<ChannelOutcome<ManagerQuestion>> {
    expiry.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  override onPauseClosed(event: ChannelPauseClosedEvent<ManagerQuestion>): Promise<void> {
    expiry.closed.push(event);
    return Promise.resolve();
  }

  onPauseExpired(
    ask: ChannelAsk<ManagerQuestion>,
  ): PauseExpiration<ManagerQuestion> | Promise<PauseExpiration<ManagerQuestion>> {
    expiry.asked.push(ask);
    expiry.holders.push(this.context.instanceId);
    return expiry.behavior?.(ask) ?? PauseExpiration.fail();
  }
}

@ChannelRole({
  name: "expiring-director-question",
  description: "Asks a director when the manager did not answer",
  ask: ExpiryOrderDto,
  answer: ExpiryDecisionDto,
  answerer: PauseAnswerer.Channel,
})
export abstract class DirectorQuestion extends ChannelOf<DirectorQuestion> {}

@Channel({ name: "director-expiry-channel", description: "Asks the director" })
export class DirectorChannel extends DirectorQuestion {
  send(ask: ChannelAsk<DirectorQuestion>): Promise<ChannelOutcome<DirectorQuestion>> {
    expiry.directorAsked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** A reviewer with no expiry handler and a 30 minutes deadline: its expiry fails the step. */
@ChannelRole({
  name: "expiring-reviewer-question",
  description: "Asks a reviewer within 30 minutes",
  ask: ExpiryOrderDto,
  answer: ExpiryDecisionDto,
  answerer: PauseAnswerer.Channel,
  expiresIn: minutes(30),
})
export abstract class ReviewerQuestion extends ChannelOf<ReviewerQuestion> {}

@Channel({ name: "reviewer-expiry-channel", description: "Asks the reviewer" })
export class ReviewerChannel extends ReviewerQuestion {
  send(): Promise<ChannelOutcome<ReviewerQuestion>> {
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
    const status = `${order.value.orderId}: ${decision.value.approved ? "approved" : "refused"}${decision.value.comment === undefined ? "" : ` (${decision.value.comment})`}`;
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
    const status = `${order.value.orderId}: escalated, ${decision.value.approved ? "approved" : "refused"}`;
    expiry.recorded.push(status);
    return Promise.resolve({ status });
  }
}

/** The manager has 24 hours; a pause that expires asks the director. */
@Workflow({
  name: "expiry-workflow",
  version: "1.0.0",
  flow: [
    start(ExpiryWorkflowStart)
      .returns(ExpiryOrderDto)
      .toQuestion(ManagerQuestion)
      .onError(
        PauseExpiredError,
        toQuestion(DirectorQuestion)
          .returns(ExpiryDecisionDto)
          .toAction(RecordEscalatedAction)
          .returns(ExpiryDoneDto)
          .toFinish(ExpiryWorkflowFinish),
      )
      .returns(ExpiryDecisionDto)
      .toAction(RecordExpiryAction)
      .returns(ExpiryDoneDto)
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

/** The step gives the manager 4 hours, over the role's 24: nothing catches the failure. */
@Workflow({
  name: "short-expiry-workflow",
  version: "1.0.0",
  flow: [
    start(ShortExpiryWorkflowStart)
      .returns(ExpiryOrderDto)
      .toQuestion(ManagerQuestion, { expiresIn: hours(4) })
      .returns(ExpiryDecisionDto)
      .toAction(RecordExpiryAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class ShortExpiryWorkflow {}

@WorkflowStart({ name: "reviewer-workflow-start", description: "An order", input: ExpiryOrderDto })
export class ReviewerWorkflowStart {}

/** A reviewer whose channel has no expiry handler: the expiry fails the run. */
@Workflow({
  name: "reviewer-workflow",
  version: "1.0.0",
  flow: [
    start(ReviewerWorkflowStart)
      .returns(ExpiryOrderDto)
      .toQuestion(ReviewerQuestion)
      .returns(ExpiryDecisionDto)
      .toAction(RecordExpiryAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class ReviewerWorkflow {}

/** A question its thread's owner answers, within 10 minutes: what an A2A caller is asked. */
@ChannelRole({
  name: "expiring-owner-question",
  description: "Asks the order's owner within 10 minutes",
  ask: ExpiryOrderDto,
  answer: ExpiryDecisionDto,
  answerer: PauseAnswerer.ThreadOwner,
  expiresIn: minutes(10),
})
export abstract class OwnerQuestion extends ChannelOf<OwnerQuestion> {}

@Channel({ name: "owner-expiry-channel", description: "Waits for the owner" })
export class OwnerChannel extends OwnerQuestion implements PauseExpiryHandler<OwnerQuestion> {
  send(): Promise<ChannelOutcome<OwnerQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  onPauseExpired(
    ask: ChannelAsk<OwnerQuestion>,
  ): PauseExpiration<OwnerQuestion> | Promise<PauseExpiration<OwnerQuestion>> {
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
    start(OwnerWorkflowStart)
      .returns(ExpiryOrderDto)
      .toQuestion(OwnerQuestion)
      .returns(ExpiryDecisionDto)
      .toAction(RecordExpiryAction)
      .returns(ExpiryDoneDto)
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
    start(PlainWorkflowStart)
      .returns(ExpiryOrderDto)
      .toQuestion(DirectorQuestion)
      .returns(ExpiryDecisionDto)
      .toAction(RecordExpiryAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class PlainWorkflow {}

/** What the observers heard of each execution: how it ended and why it was resumed. */
@Injectable()
export class ExpiryLog implements OnExecutionError, OnExecutionResume, OnExecutionEnd {
  onExecutionEnd(event: ExecutionEndEvent): void {
    expiry.ended.push(event);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    expiry.errors.push(event.error);
  }

  onExecutionResume(event: ExecutionResumeEvent): void {
    expiry.resumes.push(event);
  }
}

@Application({
  name: "expiry-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ExpiryWorkflow, ShortExpiryWorkflow, ReviewerWorkflow, PlainWorkflow, OwnerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [
    ManagerChannel,
    DirectorChannel,
    ReviewerChannel,
    OwnerChannel,
    ExpiryPausedExecutionRepository,
    RecordingLogger,
  ],
  observers: [ExpiryLog],
})
export class ExpiryApplication {}
