import type { ChannelQuestionOf } from "../flow/generated-types.js";
import type { PauseCancellation } from "../infrastructure/pause-record.js";
import type { ChannelOutcome } from "./channel-outcome.js";

/**
 * The channel contract (#267): `send`, and the optional `withdraw` (#337) — the pair of a question
 * posted and taken back. Both types take the role class, like `InputOf<X>` / `Route<R>` take the
 * component; the execution comes through `deps` (`ExecutionContext` or the project's subclass),
 * like in any component.
 */

/** What a channel is asked: the pause's id and the role's typed question. */
export interface ChannelAsk<TRole> {
  /**
   * The pause's id, a random 128-bit token made once per pause: the channel sends it, the reply
   * resumes it — and it is the idempotency key of the channel's own call.
   */
  readonly pauseId: string;
  /** The question, typed by the role (`approves` → the tool call; `ask` → that DTO). */
  readonly value: ChannelQuestionOf<TRole>;
}

/**
 * A pause the channel sent (`ChannelOutcome.awaitReply()`) that closed before its answer (#337):
 * `PauseResolution.Withdrawn` — a `FailFast` sibling failed, or its launch's quorum was decided —
 * or `PauseResolution.Cancelled` — `app.cancel`, or its tree ended. The channel takes its question
 * back (disables the buttons it posted); a late answer gets `NotPausedError` anyway.
 */
export interface ChannelWithdrawal<TRole> {
  /** The id the channel was sent with the question (its reply key). */
  readonly pauseId: string;
  /** The question it was sent, typed by the role. */
  readonly value: ChannelQuestionOf<TRole>;
  /** Why the pause closed without an answer. */
  readonly resolution: PauseCancellation;
}

/** Every channel: a role's implementation, or a concrete `@Channel` a tool names as is. */
export interface ChannelHandler<TRole> {
  readonly send: (ask: ChannelAsk<TRole>) => Promise<ChannelOutcome<TRole>>;
  /**
   * Called once when a pause this channel sent closes without an answer (#337), in the pause's
   * execution frame, under its tool's `timeout`; never for a pause it decided at once or never sent.
   * A throw is logged (`channel.withdraw-failed`) and changes nothing else.
   */
  readonly withdraw?: (withdrawal: ChannelWithdrawal<TRole>) => Promise<void>;
}

/**
 * The base of a channel role: `export abstract class RefundApprovalChannel extends
 * ChannelOf<RefundApprovalChannel> {}` with `@ChannelRole`; its implementation `extends` the role
 * and may `override` `withdraw` (a no-op by default).
 */
export abstract class ChannelOf<TRole> implements ChannelHandler<TRole> {
  abstract send(ask: ChannelAsk<TRole>): Promise<ChannelOutcome<TRole>>;

  /** Takes back the question of a pause that closed without an answer: nothing by default. */
  withdraw(withdrawal: ChannelWithdrawal<TRole>): Promise<void> {
    // a channel that posted nothing to take back: the withdrawal is read and dropped
    return Promise.resolve(withdrawal).then(() => undefined);
  }
}
