/**
 * A channel as the framework calls it (#267): its typed `send` erased — the ask's value is the
 * role's question, the returned outcome is checked at run time (`isChannelOutcome`).
 */
export interface ChannelSender {
  send(ask: ChannelSenderAsk): Promise<unknown>;
}

/** The ask as the framework builds it: the pause's id and the question. */
export interface ChannelSenderAsk {
  readonly pauseId: string;
  readonly value: unknown;
}
