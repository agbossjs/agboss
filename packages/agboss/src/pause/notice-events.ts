import type {
  PauseActor,
  PauseToolCallSummary,
  PauseTrailEntry,
} from "../channels/pause-contexts.js";
import type { PauseOutputOf, PauseInputOf } from "../flow/generated-types.js";
import type { PauseClosedReason, PauseKind } from "../infrastructure/pause-record.js";
import { type PauseRespondent } from "./respondent.js";

/**
 * What a channel and a listener are told of a pause (#940, #910 Q8): every type is an `…Event`
 * named after its receiver — `ChannelPause…Event` for the channel that asked, `ChannelListener…Event`
 * for an application's listener. `actor` always says who answered, `respondent` who may.
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
export interface ChannelPauseClosedEvent<TTarget> extends PauseDeliveredEvent {
  /** The id the channel was sent. */
  readonly pauseId: string;
  /** What it asked, as `send` got it. */
  readonly input: PauseInputOf<TTarget>;
  /** The tool call an approval waited on. */
  readonly toolCall?: PauseToolCallSummary;
  readonly reason: PauseClosedReason;
  /** When it closed; an expiry: its deadline. */
  readonly closedAt: Date;
  /** Answered: the resume's `actor`, or the thread's owner. */
  readonly actor?: PauseActor;
  /** Answered, or an expiry's decision: masked by the PII policy. */
  readonly answer?: PauseOutputOf<TTarget>;
}

/** Its recorded answer was never applied (its run ended first); told after its `closed`. */
export interface ChannelPauseAnswerNotTakenEvent<TTarget> extends PauseDeliveredEvent {
  readonly pauseId: string;
  readonly input: PauseInputOf<TTarget>;
  readonly toolCall?: PauseToolCallSummary;
  /** Why it was not applied. */
  readonly reason: PauseClosedReason.Cancelled | PauseClosedReason.TreeEnded;
  /** When its tree's end closed it. */
  readonly at: Date;
  /** Who had answered. */
  readonly actor?: PauseActor;
  /** The answer not applied, masked. */
  readonly answer: PauseOutputOf<TTarget>;
}

/** A pause this channel sent has another deadline (#942): an operator changed it. */
export interface ChannelPauseTimeoutChangedEvent<TTarget> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** What it asked, as `send` got it. */
  readonly input: PauseInputOf<TTarget>;
  /** The tool call an approval waited on. */
  readonly toolCall?: PauseToolCallSummary;
  /** The new deadline; absent: none now (`Timeout.None`). */
  readonly expiresAt?: Date;
  /** The deadline it had; absent: none. */
  readonly previousExpiresAt?: Date;
  /** Who changed it (`actor` of the call). */
  readonly actor?: PauseActor;
  /** Why, as the pause's chain of custody keeps it: masked by the workflow's PII policy. */
  readonly reason?: string;
}

/** A pause this channel sent is about to expire (#942): `remindBefore` before its deadline. */
export interface ChannelPauseExpiringEvent<TTarget> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** What it asked, as `send` got it. */
  readonly input: PauseInputOf<TTarget>;
  /** The tool call an approval waited on. */
  readonly toolCall?: PauseToolCallSummary;
  /** The deadline. */
  readonly expiresAt: Date;
}

/**
 * An answer of a pause this channel sent belongs to a parallel step that did not collect all its
 * answers (#945): the launch's error path is running. Neutral — the handler may still carry the work
 * on with the answers given. Delivered like `onPauseClosed`, at most once written per pause.
 */
export interface ChannelPauseJoinFailedEvent<TTarget> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** What it asked, as `send` got it. */
  readonly input: PauseInputOf<TTarget>;
  /** The tool call an approval waited on. */
  readonly toolCall?: PauseToolCallSummary;
  /** The launching step: `${executionId}:${nodeId}:${visit}` of the launch. */
  readonly launch: string;
  /** The failing branch's error code (`step.pause-expired`). */
  readonly errorCode: string;
  /** When the join failed. */
  readonly at: Date;
}

/** What a listener reads of every pause: the full safe context. */
export interface ChannelListenerEventBase extends PauseDeliveredEvent {
  /** Correlation, answers nothing: `pauseKeyOf(tenantId, pauseId)`. */
  readonly pauseKey: string;
  /**
   * An owner's pause: its id always; a delegate's: only for a listener declared
   * `includePauseIds` (the id of a delegate's pause is the right to answer it).
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
  /** The pause target's name. */
  readonly target: string;
  /** The channel asked; absent for an owner's pause nobody is asked about. */
  readonly channel?: string;
  /** Who may answer it. */
  readonly respondent: PauseRespondent;
  /** What it asks, masked. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The tool call an approval waits on, masked. */
  readonly toolCall?: PauseToolCallSummary;
  /** Who it is for, masked. */
  readonly assignees?: readonly string[];
  /** The id its channel's system gave it, masked. */
  readonly externalRef?: string;
  /** Its chain of custody, newest last, masked. */
  readonly trail: readonly PauseTrailEntry[];
  readonly askedAt: Date;
  readonly expiresAt?: Date;
}

/** A pause was opened: its channel was asked and awaits a reply. */
export type ChannelListenerOpenedEvent = ChannelListenerEventBase;

/** A pause closed. */
export interface ChannelListenerClosedEvent extends ChannelListenerEventBase {
  readonly reason: PauseClosedReason;
  readonly closedAt: Date;
  /** Who answered. */
  readonly actor?: PauseActor;
  /** Masked. */
  readonly answer?: unknown;
}

/** A recorded answer was never applied: its run ended first. */
export interface ChannelListenerAnswerNotTakenEvent extends ChannelListenerEventBase {
  readonly reason: PauseClosedReason.Cancelled | PauseClosedReason.TreeEnded;
  readonly at: Date;
  readonly actor?: PauseActor;
  /** Masked. */
  readonly answer: unknown;
}

/** A pause's deadline moved (#942): an operator changed it. */
export interface ChannelListenerTimeoutChangedEvent extends ChannelListenerEventBase {
  /** The new deadline; absent: none now (`Timeout.None`). */
  readonly expiresAt?: Date;
  /** The deadline it had; absent: none. */
  readonly previousExpiresAt?: Date;
  /** Who changed it (`actor` of the call). */
  readonly actor?: PauseActor;
  /** Why, as the pause's chain of custody keeps it: masked by the workflow's PII policy. */
  readonly reason?: string;
}

/** A pause is about to expire (#942): `remindBefore` before its deadline. */
export interface ChannelListenerExpiringEvent extends ChannelListenerEventBase {
  /** The deadline. */
  readonly expiresAt: Date;
}

/** An answered branch's launch did not collect all its answers (#945): its error path is running. */
export interface ChannelListenerJoinFailedEvent extends ChannelListenerEventBase {
  readonly launch: string;
  readonly errorCode: string;
  readonly at: Date;
}

/** A pause moved to another assignee, channel or target (#1307d tells it; the shape is fixed here). */
export interface ChannelListenerReassignedEvent extends ChannelListenerEventBase {
  readonly previousTarget: string;
  readonly previousChannel?: string;
  readonly previousAssignees?: readonly string[];
  readonly previousExternalRef?: string;
  readonly previousExpiresAt?: Date;
  readonly reason?: string;
  /** Who moved it; absent for the framework's own (an expiry). */
  readonly actor?: PauseActor;
}

/** A pause this channel sent was reassigned in place, on the same channel (#1307d). */
export interface ChannelPauseReassignedEvent<TTarget> extends PauseDeliveredEvent {
  readonly pauseId: string;
  /** What it asked, as `send` got it. */
  readonly input: PauseInputOf<TTarget>;
  /** The tool call an approval waited on. */
  readonly toolCall?: PauseToolCallSummary;
  readonly previousTarget: string;
  readonly previousChannel: string;
  readonly channel: string;
  /** Who it is for now; absent: nobody in particular. */
  readonly assignees?: readonly string[];
  /** Who it was for before. */
  readonly previousAssignees?: readonly string[];
  /** The id the channel's system gave it: kept by an in-place reassignment. */
  readonly externalRef?: string;
  /** The deadline now. */
  readonly expiresAt?: Date;
  /** The deadline before. */
  readonly previousExpiresAt?: Date;
  readonly reason?: string;
  /** Who moved it; absent for the framework's own (an expiry). */
  readonly actor?: PauseActor;
}
