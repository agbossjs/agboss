import type { Class } from "../components/injection.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";

/** What a reassignment asks (#946). */
export interface ReassignPauseRequest {
  /** The open pause's id: `result.pending[i].pauseId`, or the `ask.pauseId` its channel was sent. */
  readonly pauseId: string;
  /**
   * The `@ToolApproval` or `@ExternalTask` the pause waits under from now on: of its workflow, the
   * same kind and the same DTOs (`PauseError.IncompatibleTarget` otherwise). Absent: its own.
   */
  readonly target?: Class;
  /**
   * The `@Channel` that carries it from now on: one of `target`'s channels. Absent: the pause's own
   * channel when the target stays, else the target's one channel, or the one its `@ChannelSelector`
   * picks (none for an owner's target nobody serves).
   */
  readonly channel?: Class;
  /**
   * Who the pause is for now, as the channel reads it (a Slack user, an address, the members of a
   * queue): one to 100 key's texts (#589), none twice — the 1-of-N pool its answers come from;
   * `[callerId]` claims it, `[]` releases it back to nobody in particular. Absent: the target's
   * `assign` decides when it has one; otherwise a pause that stays with its target keeps them.
   */
  readonly assignees?: readonly string[];
  /**
   * How long the pause waits from now: `hours(4)`, `workHours(8)` (counted by the destination
   * target's `calendar`). Absent: a pause that stays with its target keeps its deadline; one that
   * moves to another waits that target's `resolveTimeout` or `timeout`. Never past the run's or a
   * quorum's deadline, nor the chain's `escalationLimits.maxTotalTimeout`.
   */
  readonly timeout?: Milliseconds | WorkingDuration;
  /** Why, as a person reads it in the pause's chain of custody: one to 500 characters; PII-masked before it is kept. */
  readonly reason?: string;
}

/**
 * What a reassignment did: the pause by its key, never its id. A pause that stayed with its target
 * and channel keeps its id and its key; one moved to another target or channel is a new pause — its
 * new id is a capability, it goes to the channel only (`ChannelAsk.pauseId` of the new send).
 */
export interface PauseReassignment {
  /** Correlation, answers nothing: `pauseKeyOf(tenantId, pauseId)` of the pause it waits as now. */
  readonly pauseKey: string;
  /** The target it waits under now (its name). */
  readonly target: string;
  /** The channel it is asked on now; absent for a pause nobody is asked about. */
  readonly channel?: string;
  /** Who it is for now; absent: nobody in particular. */
  readonly assignees?: readonly string[];
  /** Its deadline now; absent: none. */
  readonly expiresAt?: Date;
}
