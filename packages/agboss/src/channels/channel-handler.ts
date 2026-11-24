import type { PauseInputOf } from "../flow/generated-types.js";
import type { PauseToolCallSummary, PauseTrailEntry } from "./pause-contexts.js";
import type {
  ChannelPauseAnswerNotTakenEvent,
  ChannelPauseClosedEvent,
  ChannelPauseExpiringEvent,
  ChannelPauseJoinFailedEvent,
  ChannelPauseReassignedEvent,
  ChannelPauseTimeoutChangedEvent,
} from "../pause/notice-events.js";
import type { ChannelOutcome } from "./channel-outcome.js";

/** What a channel is asked: the pause's id and the target's typed input. */
export interface ChannelAsk<TTarget> {
  /**
   * The pause's id, a random 128-bit token made once per pause: the channel sends it, the reply
   * resumes it — and it is the idempotency key of the channel's own call.
   */
  readonly pauseId: string;
  /** What it asks, typed by the target (a `@ToolApproval`: the tool call's arguments; an `@ExternalTask`: its `input`). */
  readonly input: PauseInputOf<TTarget>;
  /** The tool call an approval waits on; absent for an external task. */
  readonly toolCall?: PauseToolCallSummary;
  /** When the pause expires; absent: it waits without a deadline. */
  readonly expiresAt?: Date;
  /**
   * Who the question is for, as the channel reads it (a Slack user, an address, the members of a
   * queue): from the target's `assign`, or the `assignees` of `app.reassignPause` (#946); absent:
   * nobody in particular. Never empty.
   */
  readonly assignees?: readonly string[];
  /** The pause's chain of custody so far: `opened`, then every reassignment; never empty. */
  readonly trail: readonly PauseTrailEntry[];
  /**
   * The pause this send replaces (#946): the old message's id, so the channel can take its buttons
   * off from `send` — or wait for `onPauseClosed(Reassigned)` of that pause; no order is imposed. Absent
   * on a first send. The old id answers nothing any more; this one is the new pause's capability.
   */
  readonly replaces?: { readonly pauseId: string };
}

/**
 * The channel contract (#267, #1307): `send`, and the optional notices (#940, #942) —
 * `onPauseClosed`, `onPauseAnswerNotTaken`, `onPauseTimeoutChanged`, `onPauseReassigned` and
 * `onPauseExpiring`, told at least once of what happened to a pause the channel sent. All types
 * take the target class, like `PauseInputOf<X>` takes it; the execution comes through `deps`
 * (`ExecutionContext` or the project's subclass), like in any component. A `@Channel` class needs
 * no `implements`: its methods are checked against this contract through its `target`.
 */
export interface ChannelHandler<TTarget> {
  readonly send: (ask: ChannelAsk<TTarget>) => Promise<ChannelOutcome<TTarget>>;
  /**
   * Called at least once whenever a pause this channel sent closes — answered (by whom, with the
   * answer, masked), expired, cancelled, withdrawn, its tree ended — in the pause's execution
   * frame, under its call `timeout`, in order per pause; the channel decides whether to update
   * its message. The same `deliveryId` on every redelivery: deduplicate by it. A throw is retried
   * with growing pauses and logged (`pause.notice-failed`), finally set aside (`pause.notice-dead`);
   * it never fails a run, a resume or a cancel. Never called for a pause it decided at once or
   * never sent.
   */
  readonly onPauseClosed?: (event: ChannelPauseClosedEvent<TTarget>) => Promise<void>;
  /** Called at least once when its recorded answer is never applied (its run ended first). */
  readonly onPauseAnswerNotTaken?: (
    event: ChannelPauseAnswerNotTakenEvent<TTarget>,
  ) => Promise<void>;
  /**
   * Called at least once when a pause this channel sent has another deadline (#942, #1307): "due
   * now …" — the new and the previous deadline. Same delivery as `onPauseClosed`.
   */
  readonly onPauseTimeoutChanged?: (
    event: ChannelPauseTimeoutChangedEvent<TTarget>,
  ) => Promise<void>;
  /**
   * Called at least once, once per deadline, `remindBefore` before a pause this channel sent
   * expires (#942): "expiring at …"; again before the new deadline after a change. Same delivery
   * as `onPauseClosed`.
   */
  readonly onPauseExpiring?: (event: ChannelPauseExpiringEvent<TTarget>) => Promise<void>;
  /** Called when a pause this channel sent was reassigned in place, on the same channel (#1307d). */
  readonly onPauseReassigned?: (event: ChannelPauseReassignedEvent<TTarget>) => Promise<void>;
  /**
   * Called at least once, once per pause, when the parallel step an answered pause belongs to did
   * not collect all its answers (#945): "the step failed on <errorCode>; its error path is running".
   * Neutral — the workflow's handler may still carry the work on. Same delivery as `onPauseClosed`.
   */
  readonly onPauseJoinFailed?: (event: ChannelPauseJoinFailedEvent<TTarget>) => Promise<void>;
}
