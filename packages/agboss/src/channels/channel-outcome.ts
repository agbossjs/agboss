import type { ChannelAnswerOf } from "../flow/generated-types.js";

/**
 * What a channel's `send` says happens next (#267): the execution waits for a reply, or the
 * answer is given now. No channel resumes the application itself, and nothing waits in memory.
 */

/** The two outcomes of `send`. */
export enum ChannelOutcomeKind {
  /** The execution pauses and is saved until the reply resumes it. */
  AwaitReply = "await-reply",
  /** The answer is given now: the step goes on with no pause. */
  Decided = "decided",
}

/** The execution pauses until the reply. */
export interface AwaitReplyOutcome {
  readonly kind: ChannelOutcomeKind.AwaitReply;
}

/** The answer given now (validated against the role's answer DTO like a reply). */
export interface DecidedOutcome<TDecision> {
  readonly kind: ChannelOutcomeKind.Decided;
  readonly decision: TDecision;
}

/** What `send` of a channel of `TRole` returns: `ChannelOutcome.awaitReply()` or `.decided(…)`. */
export type ChannelOutcome<TRole> = AwaitReplyOutcome | DecidedOutcome<ChannelAnswerOf<TRole>>;

const AWAIT_REPLY: AwaitReplyOutcome = Object.freeze({ kind: ChannelOutcomeKind.AwaitReply });

export const ChannelOutcome = {
  /** The execution pauses and is saved until the reply. */
  awaitReply(): AwaitReplyOutcome {
    return AWAIT_REPLY;
  },
  /** The answer is given now (a rule-based channel, a test channel): no pause. */
  decided<TDecision>(decision: TDecision): DecidedOutcome<TDecision> {
    return { kind: ChannelOutcomeKind.Decided, decision };
  },
} as const;

/** Whether a value `send` returned is a channel outcome (a project channel is checked at run time). */
export function isChannelOutcome(value: unknown): value is ChannelOutcome<unknown> {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === ChannelOutcomeKind.AwaitReply) return true;
  return value.kind === ChannelOutcomeKind.Decided && "decision" in value;
}
