import { Application } from "../../../src/application/application.js";
import { ApplicationContext } from "../../../src/flow/context/application-context.js";
import { Channel, Injectable } from "../../../src/components/decorators.js";
import type { ExecutionErrorEvent, OnExecutionError } from "../../../src/index.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import { PauseListener, type PauseListenerHandler } from "../../../src/pause/pause-listener.js";
import { PauseExpiration } from "../../../src/channels/pause-expiration.js";
import type {
  ChannelPauseClosedEvent,
  ChannelPauseExpiringEvent,
  ChannelPauseExtendedEvent,
  PauseListenerClosedEvent,
  PauseListenerExpiringEvent,
  PauseListenerExtendedEvent,
  PauseListenerOpenedEvent,
} from "../../../src/pause/notice-events.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { hours, seconds, type Milliseconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { ExpiryDecisionDto, ExpiryDoneDto, ExpiryOrderDto } from "./expiry.fixture.js";
import { onStart } from "./paths.js";

/**
 * #942 — a pause that is extended and reminded: a manager's approval (24 h, a reminder 2 h before),
 * the same asked of the thread's owner, a pause with no deadline, and one whose step gives it
 * less time than the reminder asks for. What the channels and the listener were told is in
 * `told`, reset per test.
 */

/** One notice a receiver was told, with the instance that told it. */
export interface Told {
  readonly receiver: "channel" | "listener";
  readonly kind: "extended" | "expiring";
  readonly instance: string;
  readonly deliveryId: string;
  readonly expiresAt: string;
  readonly previousExpiresAt?: string;
}

/** The sum of durations, a duration: `span(hours(22), seconds(10))`. */
export const span = (...parts: readonly number[]): Milliseconds =>
  seconds(parts.reduce((sum, part) => sum + part, 0) / 1000);

export const told = {
  /** Every extended / expiring notice, in order, redeliveries included. */
  notices: [] as Told[],
  /** Every ask the channels were sent. */
  sent: [] as ChannelAsk<ExtendManagerQuestion>[],
  /** Every opened / closed notice a listener heard. */
  other: [] as string[],
  recorded: [] as string[],
  /** The asks the manager channel's expiry decision was called with. */
  expiryAsked: [] as ChannelAsk<ExtendManagerQuestion>[],
  /** The errors executions failed with. */
  errors: [] as Error[],
  /** Every close the manager's channel was told, with the pause it names (#946). */
  closed: [] as { readonly pauseId: string; readonly reason: string }[],
  /** The decision the owner's channel gives at once to a reassigned send (#946); none: it waits. */
  ownerDecides: undefined as unknown,
};

export function resetTold(): void {
  told.notices.length = 0;
  told.sent.length = 0;
  told.other.length = 0;
  told.recorded.length = 0;
  told.expiryAsked.length = 0;
  told.errors.length = 0;
  told.closed.length = 0;
  told.ownerDecides = undefined;
}

@ChannelRole({
  name: "extendable-manager-question",
  description: "Asks a manager within 24 hours, a reminder 2 hours before",
  ask: ExpiryOrderDto,
  answer: ExpiryDecisionDto,
  answerer: PauseAnswerer.Channel,
  expiresIn: hours(24),
  remindBefore: hours(2),
})
export abstract class ExtendManagerQuestion extends ChannelOf<ExtendManagerQuestion> {}

@Channel({
  name: "extendable-manager-channel",
  description: "Asks the manager",
  deps: [ApplicationContext],
})
export class ExtendManagerChannel extends ExtendManagerQuestion {
  constructor(private readonly context: ApplicationContext) {
    super();
  }

  send(ask: ChannelAsk<ExtendManagerQuestion>): Promise<ChannelOutcome<ExtendManagerQuestion>> {
    told.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  /** What an expiry would decide: it goes on approved, the worst answer for a run past its deadline. */
  onPauseExpired(ask: ChannelAsk<ExtendManagerQuestion>): PauseExpiration<ExtendManagerQuestion> {
    told.expiryAsked.push(ask);
    return PauseExpiration.decide({ approved: true });
  }

  override onPauseClosed(event: ChannelPauseClosedEvent<ExtendManagerQuestion>): Promise<void> {
    told.other.push(`channel closed ${event.reason}`);
    told.closed.push({ pauseId: event.pauseId, reason: event.reason });
    return Promise.resolve();
  }

  override onPauseExtended(event: ChannelPauseExtendedEvent<ExtendManagerQuestion>): Promise<void> {
    told.notices.push({
      receiver: "channel",
      kind: "extended",
      instance: this.context.instanceId,
      deliveryId: event.deliveryId,
      expiresAt: event.expiresAt,
      previousExpiresAt: event.previousExpiresAt,
    });
    return Promise.resolve();
  }

  override onPauseExpiring(event: ChannelPauseExpiringEvent<ExtendManagerQuestion>): Promise<void> {
    told.notices.push({
      receiver: "channel",
      kind: "expiring",
      instance: this.context.instanceId,
      deliveryId: event.deliveryId,
      expiresAt: event.expiresAt,
    });
    return Promise.resolve();
  }
}

/** The thread's owner answers; the same deadline and reminder. */
@ChannelRole({
  name: "extendable-owner-question",
  description: "Asks the order's owner within 24 hours",
  ask: ExpiryOrderDto,
  answer: ExpiryDecisionDto,
  answerer: PauseAnswerer.ThreadOwner,
  expiresIn: hours(24),
  remindBefore: hours(2),
})
export abstract class ExtendOwnerQuestion extends ChannelOf<ExtendOwnerQuestion> {}

@Channel({ name: "extendable-owner-channel", description: "Waits for the owner" })
export class ExtendOwnerChannel extends ExtendOwnerQuestion {
  send(ask: ChannelAsk<ExtendOwnerQuestion>): Promise<ChannelOutcome<ExtendOwnerQuestion>> {
    // #946: the owner's channel decides at once for a reassigned send, when the test says so
    if (ask.replaces !== undefined && told.ownerDecides !== undefined)
      return Promise.resolve(ChannelOutcome.decided(told.ownerDecides as never));
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** No deadline of its own, a reminder asked for all the same: a run's deadline would bind it. */
@ChannelRole({
  name: "extendable-open-question",
  description: "Asks without a deadline",
  ask: ExpiryOrderDto,
  answer: ExpiryDecisionDto,
  answerer: PauseAnswerer.Channel,
  remindBefore: hours(2),
})
export abstract class ExtendOpenQuestion extends ChannelOf<ExtendOpenQuestion> {}

@Channel({ name: "extendable-open-channel", description: "Asks, no deadline" })
export class ExtendOpenChannel extends ExtendOpenQuestion {
  send(): Promise<ChannelOutcome<ExtendOpenQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@PauseListener({ name: "extension-pause-listener", deps: [ApplicationContext] })
export class ExtensionPauseListener implements PauseListenerHandler {
  constructor(private readonly context: ApplicationContext) {}

  onPauseOpened(event: PauseListenerOpenedEvent): Promise<void> {
    told.other.push(`listener opened ${event.workflow}`);
    return Promise.resolve();
  }

  onPauseClosed(event: PauseListenerClosedEvent): Promise<void> {
    told.other.push(`listener closed ${event.reason}`);
    return Promise.resolve();
  }

  onPauseExtended(event: PauseListenerExtendedEvent): Promise<void> {
    told.notices.push({
      receiver: "listener",
      kind: "extended",
      instance: this.context.instanceId,
      deliveryId: event.deliveryId,
      expiresAt: event.expiresAt,
      previousExpiresAt: event.previousExpiresAt,
    });
    return Promise.resolve();
  }

  onPauseExpiring(event: PauseListenerExpiringEvent): Promise<void> {
    told.notices.push({
      receiver: "listener",
      kind: "expiring",
      instance: this.context.instanceId,
      deliveryId: event.deliveryId,
      expiresAt: event.expiresAt,
    });
    return Promise.resolve();
  }
}

/** What the observers heard: the errors executions failed with. */
@Injectable()
export class ExtensionLog implements OnExecutionError {
  onExecutionError(event: ExecutionErrorEvent): void {
    told.errors.push(event.error);
  }
}

@WorkflowFinish({ name: "extension-workflow-finish", description: "Done", output: ExpiryDoneDto })
export class ExtensionWorkflowFinish {}

@Action({
  name: "record-extension-action",
  description: "Records the decision",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
export class RecordExtensionAction implements ActionHandler<RecordExtensionAction> {
  execute({
    order,
    decision,
  }: InputOf<RecordExtensionAction>): Promise<OutputOf<RecordExtensionAction>> {
    const status = `${order.value.orderId}: ${decision.value.approved ? "approved" : "refused"}`;
    told.recorded.push(status);
    return Promise.resolve({ status });
  }
}

@WorkflowStart({
  name: "extend-manager-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
export class ExtendManagerWorkflowStart {}

/** The manager has 24 hours and is reminded 2 hours before. */
@Workflow({
  name: "extend-manager-workflow",
  version: "1.0.0",
  flow: [
    onStart(ExtendManagerWorkflowStart)
      .returns(ExpiryOrderDto)
      .toExternalTask(ExtendManagerQuestion)
      .returns(ExpiryDecisionDto)
      .toAction(RecordExtensionAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExtensionWorkflowFinish),
  ],
})
export class ExtendManagerWorkflow {}

@WorkflowStart({
  name: "extend-owner-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
export class ExtendOwnerWorkflowStart {}

/** The thread's owner has 24 hours. */
@Workflow({
  name: "extend-owner-workflow",
  version: "1.0.0",
  flow: [
    onStart(ExtendOwnerWorkflowStart)
      .returns(ExpiryOrderDto)
      .toExternalTask(ExtendOwnerQuestion)
      .returns(ExpiryDecisionDto)
      .toAction(RecordExtensionAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExtensionWorkflowFinish),
  ],
})
export class ExtendOwnerWorkflow {}

@WorkflowStart({
  name: "extend-open-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
export class ExtendOpenWorkflowStart {}

/** No deadline of its own. */
@Workflow({
  name: "extend-open-workflow",
  version: "1.0.0",
  flow: [
    onStart(ExtendOpenWorkflowStart)
      .returns(ExpiryOrderDto)
      .toExternalTask(ExtendOpenQuestion)
      .returns(ExpiryDecisionDto)
      .toAction(RecordExtensionAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExtensionWorkflowFinish),
  ],
})
export class ExtendOpenWorkflow {}

@WorkflowStart({
  name: "extend-tight-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
export class ExtendTightWorkflowStart {}

/** The step gives the manager 1 hour: less than the 2 hours the reminder asks for. */
@Workflow({
  name: "extend-tight-workflow",
  version: "1.0.0",
  flow: [
    onStart(ExtendTightWorkflowStart)
      .returns(ExpiryOrderDto)
      .toExternalTask(ExtendManagerQuestion, { expiresIn: hours(1) })
      .returns(ExpiryDecisionDto)
      .toAction(RecordExtensionAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExtensionWorkflowFinish),
  ],
})
export class ExtendTightWorkflow {}

/** The workflows' starts, by what they ask. */
export const managerFlow = { start: ExtendManagerWorkflowStart, workflow: ExtendManagerWorkflow };
export const ownerFlow = { start: ExtendOwnerWorkflowStart, workflow: ExtendOwnerWorkflow };
export const openFlow = { start: ExtendOpenWorkflowStart, workflow: ExtendOpenWorkflow };
export const tightFlow = { start: ExtendTightWorkflowStart, workflow: ExtendTightWorkflow };

export const FLOWS = [managerFlow, ownerFlow, openFlow, tightFlow].map((one) => one.workflow);
export const CHANNELS = [ExtendManagerChannel, ExtendOwnerChannel, ExtendOpenChannel];

@Application({
  name: "extension-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: FLOWS,
  budgets: TEST_BUDGETS,
  providers: [...CHANNELS, ExtensionPauseListener],
  observers: [ExtensionLog],
})
export class ExtensionApplication {}
