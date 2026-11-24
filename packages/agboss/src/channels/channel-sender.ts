import type { PauseClosedReason } from "../infrastructure/pause-record.js";
import type { PauseActor, PauseToolCallSummary, PauseTrailEntry } from "./pause-contexts.js";
import type { PauseDeliveredEvent } from "../pause/notice-events.js";

/**
 * A channel as the framework calls it (#267): its typed `send` erased — the ask's value is the
 * role's question, the returned outcome is checked at run time (`isChannelOutcome`) — and its
 * optional notices (#940).
 */
export interface ChannelSender {
  send(ask: ChannelSenderSend): Promise<unknown>;
  onPauseClosed?(event: ChannelSenderClosed): Promise<void>;
  onPauseAnswerNotTaken?(event: ChannelSenderNotTaken): Promise<void>;
  onPauseExtended?(event: ChannelSenderExtended): Promise<void>;
  /** The new name of `onPauseExtended` (#1307). */
  onPauseTimeoutChanged?(event: ChannelSenderExtended): Promise<void>;
  onPauseExpiring?(event: ChannelSenderExpiring): Promise<void>;
  onPauseJoinFailed?(event: ChannelSenderJoinFailed): Promise<void>;
  /** What the expiry of a pause it sent means (#941); absent: `PauseExpiration.fail()`. */
  onPauseExpired?(ask: ChannelSenderSend): unknown;
}

/** The ask as the framework builds it: the pause's id and what it asks. */
export interface ChannelSenderAsk {
  readonly pauseId: string;
  /** What it asks (the tool call's arguments, or the external task's input), `sensitive` fields masked. */
  readonly input: unknown;
  /** The tool call an approval waits on. */
  readonly toolCall?: PauseToolCallSummary;
}

/** The ask a channel is sent: the pause's id and question, its deadline, who it is for, its chain of custody — and, on a reassigned send, what it replaces (#946). */
export interface ChannelSenderSend extends ChannelSenderAsk {
  readonly expiresAt?: Date;
  readonly assignees?: readonly string[];
  readonly trail: readonly PauseTrailEntry[];
  readonly replaces?: { readonly pauseId: string };
}

/** A close as the framework builds it, typed per role by the channel's own signature. */
export interface ChannelSenderClosed extends ChannelSenderAsk, PauseDeliveredEvent {
  readonly reason: PauseClosedReason;
  readonly closedAt: string;
  readonly actor?: PauseActor;
  readonly answer?: unknown;
}

/** An answer never applied, as the framework builds it. */
export interface ChannelSenderNotTaken extends ChannelSenderAsk, PauseDeliveredEvent {
  readonly reason: PauseClosedReason.Cancelled | PauseClosedReason.TreeEnded;
  readonly at: string;
  readonly actor?: PauseActor;
  readonly answer: unknown;
}

/** An extension as the framework builds it (#942). */
export interface ChannelSenderExtended extends ChannelSenderAsk, PauseDeliveredEvent {
  readonly expiresAt: string;
  readonly previousExpiresAt: string;
}

/** A reminder as the framework builds it (#942). */
export interface ChannelSenderExpiring extends ChannelSenderAsk, PauseDeliveredEvent {
  readonly expiresAt: string;
}

/** A failed join as the framework builds it (#945). */
export interface ChannelSenderJoinFailed extends ChannelSenderAsk, PauseDeliveredEvent {
  readonly launch: string;
  readonly errorCode: string;
  readonly at: string;
}
