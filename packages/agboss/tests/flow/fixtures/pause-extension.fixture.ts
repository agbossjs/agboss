import { Application } from "../../../src/application/application.js";
import { ApplicationContext } from "../../../src/flow/context/application-context.js";
import { Channel } from "../../../src/components/decorators.js";
import { ChannelSelector } from "../../../src/channels/channel-selector.js";
import type { ExpiredContext } from "../../../src/channels/pause-contexts.js";
import type { ExecutionErrorEvent } from "../../../src/index.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelListener } from "../../../src/pause/channel-listener.js";
import { PauseExpiration } from "../../../src/channels/pause-expiration.js";
import type {
  ChannelPauseClosedEvent,
  ChannelPauseExpiringEvent,
  ChannelPauseTimeoutChangedEvent,
  ChannelListenerClosedEvent,
  ChannelListenerExpiringEvent,
  ChannelListenerTimeoutChangedEvent,
  ChannelListenerOpenedEvent,
} from "../../../src/pause/notice-events.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { hours, seconds, type Milliseconds, days, Ttl } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { ExpiryDecisionDto, ExpiryDoneDto, ExpiryOrderDto } from "./expiry.fixture.js";
import { onStart } from "./paths.js";
import {
  Observer,
  type PauseReassignedEvent,
  type PauseTimeoutChangedEvent,
  ExternalTask,
} from "../../../src/index.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";

/**
 * #942 — a pause that is extended and reminded: a manager's approval (24 h, a reminder 2 h before),
 * the same asked of the thread's owner, a pause with no deadline, and one whose step gives it
 * less time than the reminder asks for (#1307d: a target's `resolveTimeout`). What the channels and the listener were told is in
 * `told`, reset per test.
 */

/** One notice a receiver was told, with the instance that told it. */
export interface Told {
  readonly receiver: "channel" | "listener";
  readonly kind: "timeout-changed" | "expiring";
  readonly instance: string;
  readonly deliveryId: string;
  readonly expiresAt?: string;
  readonly previousExpiresAt?: string;
  readonly actor?: { readonly id: string };
  readonly reason?: string;
}

/** The sum of durations, a duration: `span(hours(22), seconds(10))`. */
export const span = (...parts: readonly number[]): Milliseconds =>
  seconds(parts.reduce((sum, part) => sum + part, 0) / 1000);

export const told = {
  /** Every extended / expiring notice, in order, redeliveries included. */
  notices: [] as Told[],
  /** Every ask the channels were sent. */
  sent: [] as ChannelAsk<ExtendManagerExternalTask>[],
  /** Every opened / closed notice a listener heard. */
  other: [] as string[],
  recorded: [] as string[],
  /** The asks the manager channel's expiry decision was called with. */
  expiryAsked: [] as ExpiredContext<ExtendManagerExternalTask>[],
  /** The errors executions failed with. */
  errors: [] as Error[],
  /** Every pause an operator extended or reassigned, as the observers were told (#1343). */
  changes: [] as (PauseTimeoutChangedEvent | PauseReassignedEvent)[],
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
  told.changes.length = 0;
  told.closed.length = 0;
  told.ownerDecides = undefined;
}

@ExternalTask({
  name: "extendable-manager-external-task",
  description: "Asks a manager within 24 hours, a reminder 2 hours before",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
  remindBefore: hours(2),
})
export class ExtendManagerExternalTask {
  /** What an expiry would decide: it goes on approved, the worst answer for a run past its deadline. */
  onExpired(
    ctx: ExpiredContext<ExtendManagerExternalTask>,
  ): PauseExpiration<ExtendManagerExternalTask> {
    told.expiryAsked.push(ctx);
    return PauseExpiration.decide({ approved: true });
  }
}

/** What the manager's channels share. */
abstract class ExtendManagerChannelBase {
  constructor(private readonly context: ApplicationContext) {}

  send(
    ask: ChannelAsk<ExtendManagerExternalTask>,
  ): Promise<ChannelOutcome<ExtendManagerExternalTask>> {
    told.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }

  onPauseClosed(event: ChannelPauseClosedEvent<ExtendManagerExternalTask>): Promise<void> {
    told.other.push(`channel closed ${event.reason}`);
    told.closed.push({ pauseId: event.pauseId, reason: event.reason });
    return Promise.resolve();
  }

  onPauseTimeoutChanged(
    event: ChannelPauseTimeoutChangedEvent<ExtendManagerExternalTask>,
  ): Promise<void> {
    told.notices.push({
      receiver: "channel",
      kind: "timeout-changed",
      instance: this.context.instanceId,
      deliveryId: event.deliveryId,
      expiresAt: event.expiresAt,
      previousExpiresAt: event.previousExpiresAt,
      ...(event.actor === undefined ? {} : { actor: event.actor }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    return Promise.resolve();
  }

  onPauseExpiring(event: ChannelPauseExpiringEvent<ExtendManagerExternalTask>): Promise<void> {
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
@ExternalTask({
  name: "extendable-owner-external-task",
  description: "Asks the order's owner within 24 hours",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
  remindBefore: hours(2),
})
export class ExtendOwnerExternalTask {}

/** What the owner's channels share. */
abstract class ExtendOwnerChannelBase {
  send(ask: ChannelAsk<ExtendOwnerExternalTask>): Promise<ChannelOutcome<ExtendOwnerExternalTask>> {
    // #946: the owner's channel decides at once for a reassigned send, when the test says so
    if (ask.replaces !== undefined && told.ownerDecides !== undefined)
      return Promise.resolve(ChannelOutcome.decided(told.ownerDecides as never));
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({
  name: "extendable-owner-channel",
  description: "Waits for the owner",
  target: ExtendOwnerExternalTask,
  ttl: days(1),
})
export class ExtendOwnerChannel extends ExtendOwnerChannelBase {}

/** The owner's second channel: where a reassignment across channels goes. */
@Channel({
  name: "extendable-owner-backup-channel",
  description: "Waits for the owner, on the backup route",
  target: ExtendOwnerExternalTask,
  ttl: days(1),
})
export class ExtendOwnerBackupChannel extends ExtendOwnerChannelBase {}

@ChannelSelector({
  name: "extendable-owner-selector",
  description: "Picks the first owner channel",
  target: ExtendOwnerExternalTask,
})
export class ExtendOwnerSelector {
  selectChannel(): typeof ExtendOwnerChannel {
    return ExtendOwnerChannel;
  }
}

/** No deadline of its own, a reminder asked for all the same: a run's deadline would bind it. */
@ExternalTask({
  name: "extendable-open-external-task",
  description: "Asks without a deadline",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
  remindBefore: hours(2),
})
export class ExtendOpenExternalTask {}

@Channel({
  name: "extendable-open-channel",
  description: "Asks, no deadline",
  target: ExtendOpenExternalTask,
  ttl: days(1),
})
export class ExtendOpenChannel {
  send(): Promise<ChannelOutcome<ExtendOpenExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@ChannelListener({ name: "extension-pause-listener", deps: [ApplicationContext] })
export class ExtensionPauseListener {
  constructor(private readonly context: ApplicationContext) {}

  onPauseOpened(event: ChannelListenerOpenedEvent): Promise<void> {
    told.other.push(`listener opened ${event.workflow}`);
    return Promise.resolve();
  }

  onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    told.other.push(`listener closed ${event.reason}`);
    return Promise.resolve();
  }

  onPauseTimeoutChanged(event: ChannelListenerTimeoutChangedEvent): Promise<void> {
    told.notices.push({
      receiver: "listener",
      kind: "timeout-changed",
      instance: this.context.instanceId,
      deliveryId: event.deliveryId,
      expiresAt: event.expiresAt,
      previousExpiresAt: event.previousExpiresAt,
      ...(event.actor === undefined ? {} : { actor: event.actor }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    return Promise.resolve();
  }

  onPauseExpiring(event: ChannelListenerExpiringEvent): Promise<void> {
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
@Observer()
export class ExtensionLog {
  onExecutionError(event: ExecutionErrorEvent): void {
    told.errors.push(event.error);
  }

  onPauseTimeoutChanged(event: PauseTimeoutChangedEvent): void {
    told.changes.push(event);
  }

  onPauseReassigned(event: PauseReassignedEvent): void {
    told.changes.push(event);
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
    const status = `${order.orderId}: ${decision.approved ? "approved" : "refused"}`;
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ExtendManagerWorkflowStart)
      .toExternalTask(ExtendManagerExternalTask)
      .toAction(RecordExtensionAction)
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ExtendOwnerWorkflowStart)
      .toExternalTask(ExtendOwnerExternalTask)
      .toAction(RecordExtensionAction)
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ExtendOpenWorkflowStart)
      .toExternalTask(ExtendOpenExternalTask)
      .toAction(RecordExtensionAction)
      .toFinish(ExtensionWorkflowFinish),
  ],
})
export class ExtendOpenWorkflow {}

/** The workflows' starts, by what they ask. */
export const managerFlow = { start: ExtendManagerWorkflowStart, workflow: ExtendManagerWorkflow };
export const ownerFlow = { start: ExtendOwnerWorkflowStart, workflow: ExtendOwnerWorkflow };
export const openFlow = { start: ExtendOpenWorkflowStart, workflow: ExtendOpenWorkflow };

export const FLOWS = [managerFlow, ownerFlow, openFlow].map((one) => one.workflow);
@Channel({
  name: "extendable-manager-channel",
  description: "Asks the manager",
  deps: [ApplicationContext],
  target: ExtendManagerExternalTask,
  ttl: days(1),
})
export class ExtendManagerChannel extends ExtendManagerChannelBase {}

/** The manager's second channel: where a reassignment across channels goes. */
@Channel({
  name: "extendable-manager-backup-channel",
  description: "Asks the manager, on the backup route",
  deps: [ApplicationContext],
  target: ExtendManagerExternalTask,
  ttl: days(1),
})
export class ExtendManagerBackupChannel extends ExtendManagerChannelBase {}

/** New pauses of the manager go to the first channel; a reassignment names the backup one. */
@ChannelSelector({
  name: "extendable-manager-selector",
  description: "Picks the first manager channel",
  target: ExtendManagerExternalTask,
})
export class ExtendManagerSelector {
  selectChannel(): typeof ExtendManagerChannel {
    return ExtendManagerChannel;
  }
}

export const CHANNELS = [
  ExtendManagerChannel,
  ExtendManagerBackupChannel,
  ExtendManagerSelector,
  ExtendOwnerChannel,
  ExtendOwnerBackupChannel,
  ExtendOwnerSelector,
  ExtendOpenChannel,
];

@Application({
  name: "extension-application",
  version: "1.0.0",
  workflows: FLOWS,
  budgets: TEST_BUDGETS,
  providers: [...CHANNELS, ExtensionPauseListener],
  observers: [ExtensionLog],
})
export class ExtensionApplication {}
