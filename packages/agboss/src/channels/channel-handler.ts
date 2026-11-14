import type { ChannelQuestionOf } from "../flow/generated-types.js";
import type {
  ChannelPauseAnswerNotTakenEvent,
  ChannelPauseClosedEvent,
} from "../pause/notice-events.js";
import type { ChannelOutcome } from "./channel-outcome.js";

/**
 * The channel contract (#267): `send`, and the optional notices (#940) — `onPauseClosed` and
 * `onPauseAnswerNotTaken`, told at least once of what happened to a pause the channel sent. Both
 * types take the role class, like `InputOf<X>` / `Route<R>` take the component; the execution
 * comes through `deps` (`ExecutionContext` or the project's subclass), like in any component.
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

/** Every channel: a role's implementation, or a concrete `@Channel` a tool names as is. */
export interface ChannelHandler<TRole> {
  readonly send: (ask: ChannelAsk<TRole>) => Promise<ChannelOutcome<TRole>>;
  /**
   * Called at least once whenever a pause this channel sent closes — answered (by whom, with the
   * answer, masked), expired, cancelled, withdrawn, its tree ended — in the pause's execution
   * frame, under its tool's `timeout`, in order per pause; the channel decides whether to update
   * its message. The same `deliveryId` on every redelivery: deduplicate by it. A throw is retried
   * with growing pauses and logged (`pause.notice-failed`), finally set aside (`pause.notice-dead`);
   * it never fails a run, a resume or a cancel. Never called for a pause it decided at once or
   * never sent.
   */
  readonly onPauseClosed?: (event: ChannelPauseClosedEvent<TRole>) => Promise<void>;
  /** Called at least once when its recorded answer is never applied (its run ended first). */
  readonly onPauseAnswerNotTaken?: (event: ChannelPauseAnswerNotTakenEvent<TRole>) => Promise<void>;
}

/**
 * The base of a channel role: `export abstract class RefundApprovalChannel extends
 * ChannelOf<RefundApprovalChannel> {}` with `@ChannelRole`; its implementation `extends` the role
 * and may `override` the notices (nothing by default: a channel that overrides none has no
 * mailbox, a pause costs it nothing).
 */
export abstract class ChannelOf<TRole> implements ChannelHandler<TRole> {
  abstract send(ask: ChannelAsk<TRole>): Promise<ChannelOutcome<TRole>>;

  /** A pause this channel sent closed: nothing by default. */
  onPauseClosed(event: ChannelPauseClosedEvent<TRole>): Promise<void> {
    return Promise.resolve(event).then(() => undefined);
  }

  /** Its recorded answer was never applied: nothing by default. */
  onPauseAnswerNotTaken(event: ChannelPauseAnswerNotTakenEvent<TRole>): Promise<void> {
    return Promise.resolve(event).then(() => undefined);
  }
}
