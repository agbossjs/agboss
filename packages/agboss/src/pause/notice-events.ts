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
