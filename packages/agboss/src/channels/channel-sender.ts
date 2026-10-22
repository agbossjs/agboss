import type { PauseCancellation } from "../infrastructure/pause-record.js";

/**
 * A channel as the framework calls it (#267): its typed `send` erased — the ask's value is the
 * role's question, the returned outcome is checked at run time (`isChannelOutcome`) — and its
 * optional `withdraw` (#337).
 */
export interface ChannelSender {
  send(ask: ChannelSenderAsk): Promise<unknown>;
  withdraw?(withdrawal: ChannelSenderWithdrawal): Promise<void>;
}

/** The ask as the framework builds it: the pause's id and the question. */
export interface ChannelSenderAsk {
  readonly pauseId: string;
  readonly value: unknown;
}

/** A withdrawal as the framework builds it: the ask it takes back and why. */
export interface ChannelSenderWithdrawal extends ChannelSenderAsk {
  readonly resolution: PauseCancellation;
}
