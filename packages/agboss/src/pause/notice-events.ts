import type { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ChannelAnswerOf, ChannelQuestionOf } from "../flow/generated-types.js";
import type { PauseClosedReason, PauseKind } from "../infrastructure/pause-record.js";

/**
 * What a channel and a listener are told of a pause (#940, #910 Q8): every type is an `…Event`
 * named after its receiver — `ChannelPause…Event` for the channel that asked, `PauseListener…Event`
 * for an application's listener. `answeredBy` always says who answered, `answerer` who may.
 */

/**
 * Every event a channel or a listener receives carries `deliveryId`: the idempotency key of that
 * one notice to that one receiver — the same on every redelivery, different for every other
 * notice. Delivery is at least once; deduplicating by `deliveryId` is the receiver's job.
 */
export interface PauseDeliveredEvent {
  readonly deliveryId: string;
}

/** A pause this channel sent closed: at least once, in order, in the pause's execution frame. */
export interface ChannelPauseClosedEvent<TRole> extends PauseDeliveredEvent {
  /** The id the channel was sent. */
  readonly pauseId: string;
  /** The question as `send` got it. */
  readonly value: ChannelQuestionOf<TRole>;
  readonly reason: PauseClosedReason;
  /** ISO 8601 (an expiry: the deadline). */
  readonly closedAt: string;
  /** Answered: the resume's `answeredBy`, or the thread's owner. */
  readonly answeredBy?: string;
  /** Answered, or an expiry's decision: masked by the PII policy. */
  readonly answer?: ChannelAnswerOf<TRole>;
}

/** Its recorded answer was never applied (its run ended first); told after its `closed`. */
export interface ChannelPauseAnswerNotTakenEvent<TRole> extends PauseDeliveredEvent {
  readonly pauseId: string;
  readonly value: ChannelQuestionOf<TRole>;
  /** Why it was not applied. */
  readonly reason: PauseClosedReason.Cancelled | PauseClosedReason.TreeEnded;
  /** When its tree's end closed it (ISO 8601). */
  readonly at: string;
  /** Who had answered. */
  readonly answeredBy?: string;
  /** The answer not applied, masked. */
  readonly answer: ChannelAnswerOf<TRole>;
}

/** A pause this channel sent has a later deadline (#942): an operator extended it. */
export interface ChannelPauseExtendedEvent<TRole> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** The question as `send` got it. */
  readonly value: ChannelQuestionOf<TRole>;
  /** The new deadline (ISO 8601). */
  readonly expiresAt: string;
  /** The deadline it had (ISO 8601). */
  readonly previousExpiresAt: string;
}

/** A pause this channel sent is about to expire (#942): `remindBefore` before its deadline. */
export interface ChannelPauseExpiringEvent<TRole> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** The question as `send` got it. */
  readonly value: ChannelQuestionOf<TRole>;
  /** The deadline (ISO 8601). */
  readonly expiresAt: string;
}

/**
 * An answer of a pause this channel sent belongs to a parallel step that did not collect all its
 * answers (#945): the launch's error path is running. Neutral — the handler may still carry the work
 * on with the answers given. Delivered like `onPauseClosed`, at most once written per pause.
 */
export interface ChannelPauseJoinFailedEvent<TRole> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** The question as `send` got it. */
  readonly value: ChannelQuestionOf<TRole>;
  /** The launching step: `${executionId}:${nodeId}:${visit}` of the launch. */
  readonly launch: string;
  /** The failing branch's error code (`step.pause-expired`). */
  readonly errorCode: string;
  /** When the join failed (ISO 8601). */
  readonly at: string;
}

/** What a listener reads of every pause: the full safe context. */
export interface PauseListenerEventBase extends PauseDeliveredEvent {
  /** Correlation, answers nothing: `pauseKeyOf(tenantId, pauseId)`. */
  readonly pauseKey: string;
  /**
   * A thread owner's pause: its id always; a channel's: only for a listener declared
   * `allowAnswering` (the id of a channel's pause is the right to answer it).
   */
  readonly pauseId?: string;
  readonly tenantId: string;
  readonly rootExecutionId: string;
  /** The root's or a child's. */
  readonly executionId: string;
  readonly threadId: string;
  /** The workflow it waits in. */
  readonly workflow: string;
  /** The asking agent or question step. */
  readonly step: string;
  readonly kind: PauseKind;
  /** The role's (or a concrete channel's) name. */
  readonly channel: string;
  /** Who may answer it. */
  readonly answerer: PauseAnswerer;
  /** Masked. */
  readonly ask: unknown;
  readonly askedAt: string;
  readonly expiresAt?: string;
}

/** A pause was opened: its channel was asked and awaits a reply. */
export type PauseListenerOpenedEvent = PauseListenerEventBase;

/** A pause closed. */
export interface PauseListenerClosedEvent extends PauseListenerEventBase {
  readonly reason: PauseClosedReason;
  readonly closedAt: string;
  /** Who answered. */
  readonly answeredBy?: string;
  /** Masked. */
  readonly answer?: unknown;
}

/** A recorded answer was never applied: its run ended first. */
export interface PauseListenerAnswerNotTakenEvent extends PauseListenerEventBase {
  readonly reason: PauseClosedReason.Cancelled | PauseClosedReason.TreeEnded;
  readonly at: string;
  readonly answeredBy?: string;
  /** Masked. */
  readonly answer: unknown;
}

/** A pause's deadline moved (#942): an operator extended it. */
export interface PauseListenerExtendedEvent extends PauseListenerEventBase {
  /** The new deadline (ISO 8601). */
  readonly expiresAt: string;
  /** The deadline it had (ISO 8601). */
  readonly previousExpiresAt: string;
}

/** A pause is about to expire (#942): `remindBefore` before its deadline. */
export interface PauseListenerExpiringEvent extends PauseListenerEventBase {
  /** The deadline (ISO 8601). */
  readonly expiresAt: string;
}

/** An answered branch's launch did not collect all its answers (#945): its error path is running. */
export interface PauseListenerJoinFailedEvent extends PauseListenerEventBase {
  readonly launch: string;
  readonly errorCode: string;
  readonly at: string;
}

/*
 * The `@ChannelListener` / `@Channel` names of the notices (#1310c, #1307a). A notice is told under
 * the shape it has today; the shapes of #1307b / #1307d (`actor`, `target`, `assignees`, `trail`, …)
 * come with the records they are made from.
 */

/** Every event a `@ChannelListener` receives has what a pause listener's has. */
export type ChannelListenerEventBase = PauseListenerEventBase;
export type ChannelListenerOpenedEvent = PauseListenerOpenedEvent;
export type ChannelListenerClosedEvent = PauseListenerClosedEvent;
export type ChannelListenerAnswerNotTakenEvent = PauseListenerAnswerNotTakenEvent;
export type ChannelListenerExpiringEvent = PauseListenerExpiringEvent;
export type ChannelListenerJoinFailedEvent = PauseListenerJoinFailedEvent;
/** A pause's deadline moved: today an operator's extension (#942). */
export type ChannelListenerTimeoutChangedEvent = PauseListenerExtendedEvent;
/** A pause this channel sent has another deadline: today an operator's extension (#942). */
export type ChannelPauseTimeoutChangedEvent<TTarget> = ChannelPauseExtendedEvent<TTarget>;

/** A pause moved to another assignee, channel or target (#1307d tells it; the shape is fixed here). */
export interface ChannelListenerReassignedEvent extends PauseListenerEventBase {
  readonly previousTarget: string;
  readonly previousChannel?: string;
  readonly previousAssignees?: readonly string[];
  readonly previousExternalRef?: string;
  readonly previousExpiresAt?: Date;
  readonly reason?: string;
}

/** A pause this channel sent was reassigned in place, on the same channel (#1307d). */
export interface ChannelPauseReassignedEvent<TTarget> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** The question as `send` got it. */
  readonly value: ChannelQuestionOf<TTarget>;
  readonly previousTarget: string;
  readonly previousChannel: string;
  readonly channel: string;
  readonly reason?: string;
}
