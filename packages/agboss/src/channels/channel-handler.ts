import type { ChannelQuestionOf } from "../flow/generated-types.js";
import type {
  ChannelPauseAnswerNotTakenEvent,
  ChannelPauseClosedEvent,
  ChannelPauseExpiringEvent,
  ChannelPauseExtendedEvent,
  ChannelPauseJoinFailedEvent,
} from "../pause/notice-events.js";
import type { ChannelOutcome } from "./channel-outcome.js";

/**
 * The channel contract (#267): `send`, and the optional notices (#940, #942) — `onPauseClosed`,
 * `onPauseAnswerNotTaken`, `onPauseExtended` and `onPauseExpiring`, told at least once of what
 * happened to a pause the channel sent. All
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
  /**
   * Called at least once when an operator extended a pause this channel sent (#942): "extended
   * until …" — the new and the previous deadline. Same delivery as `onPauseClosed`.
   */
  readonly onPauseExtended?: (event: ChannelPauseExtendedEvent<TRole>) => Promise<void>;
  /**
   * Called at least once, once per deadline, `remindBefore` before a pause this channel sent
   * expires (#942): "expiring at …"; again before the new deadline after an extension. Same
   * delivery as `onPauseClosed`.
   */
  readonly onPauseExpiring?: (event: ChannelPauseExpiringEvent<TRole>) => Promise<void>;
  /**
   * Called at least once, once per pause, when the parallel step an answered pause belongs to did
   * not collect all its answers (#945): "the step failed on <errorCode>; its error path is running".
   * Neutral — the workflow's handler may still carry the work on. Same delivery as `onPauseClosed`.
   */
  readonly onPauseJoinFailed?: (event: ChannelPauseJoinFailedEvent<TRole>) => Promise<void>;
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

  /** A pause this channel sent has a later deadline (#942): nothing by default. */
  onPauseExtended(event: ChannelPauseExtendedEvent<TRole>): Promise<void> {
    return Promise.resolve(event).then(() => undefined);
  }

  /** A pause this channel sent is about to expire (#942): nothing by default. */
  onPauseExpiring(event: ChannelPauseExpiringEvent<TRole>): Promise<void> {
    return Promise.resolve(event).then(() => undefined);
  }

  /** The parallel step this answer belongs to did not collect all its answers (#945): nothing by default. */
  onPauseJoinFailed(event: ChannelPauseJoinFailedEvent<TRole>): Promise<void> {
    return Promise.resolve(event).then(() => undefined);
  }
}
