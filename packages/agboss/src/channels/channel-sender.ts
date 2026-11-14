import type { PauseClosedReason } from "../infrastructure/pause-record.js";
import type { PauseDeliveredEvent } from "../pause/notice-events.js";

/**
 * A channel as the framework calls it (#267): its typed `send` erased — the ask's value is the
 * role's question, the returned outcome is checked at run time (`isChannelOutcome`) — and its
 * optional notices (#940).
 */
export interface ChannelSender {
  send(ask: ChannelSenderAsk): Promise<unknown>;
  onPauseClosed?(event: ChannelSenderClosed): Promise<void>;
  onPauseAnswerNotTaken?(event: ChannelSenderNotTaken): Promise<void>;
}

/** The ask as the framework builds it: the pause's id and the question. */
export interface ChannelSenderAsk {
  readonly pauseId: string;
  readonly value: unknown;
}

/** A close as the framework builds it, typed per role by the channel's own signature. */
export interface ChannelSenderClosed extends ChannelSenderAsk, PauseDeliveredEvent {
  readonly reason: PauseClosedReason;
  readonly closedAt: string;
  readonly answeredBy?: string;
  readonly answer?: unknown;
}

/** An answer never applied, as the framework builds it. */
export interface ChannelSenderNotTaken extends ChannelSenderAsk, PauseDeliveredEvent {
  readonly reason: PauseClosedReason.Cancelled | PauseClosedReason.TreeEnded;
  readonly at: string;
  readonly answeredBy?: string;
  readonly answer: unknown;
}
