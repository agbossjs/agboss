import type { Milliseconds, Timeout, WorkingDuration } from "../units/index.js";

/** What a timeout change asks (#1307). */
export interface SetPauseTimeoutRequest {
  /** The pause's id: `result.pending[i].pauseId`, or the `ask.pauseId` its channel was sent. */
  readonly pauseId: string;
  /**
   * How long from now the pause waits: its new deadline is `now + timeout` — later or earlier than
   * the current one — at least `seconds(1)`; `workHours(8)` counts the target's calendar (#944).
   * `Timeout.None` takes the deadline away. Never past the run's or a quorum's deadline, nor the
   * chain's `escalationLimits.maxTotalTimeout`.
   */
  readonly timeout: Milliseconds | WorkingDuration | Timeout;
  /** Why, as a person reads it in the pause's chain of custody: one to 500 characters; PII-masked before it is kept. */
  readonly reason?: string;
}

/** What a timeout change did: the deadline before and after (absent: none). */
export interface PauseTimeoutChangeResult {
  /** The new deadline; absent: the pause has none now (`Timeout.None`). */
  readonly expiresAt?: Date;
  /** The deadline it had; absent: it had none. */
  readonly previousExpiresAt?: Date;
}
