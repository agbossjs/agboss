import type { Milliseconds, WorkingDuration } from "../units/index.js";

/** What an extension asks. */
export interface ExtendPauseRequest {
  /** The pause's id: `result.pending[i].pauseId`, or the `ask.pauseId` its channel was sent. */
  readonly pauseId: string;
  /**
   * How long from now the pause waits: its new deadline is `now + expiresIn` (at least `seconds(1)`);
   * `workingHours(8)` counts the pause's calendar (#944): `calendar.add(now, expiresIn)`.
   */
  readonly expiresIn: Milliseconds | WorkingDuration;
}

/** What an extension did: the pause by its key (never its id) and the deadline before and after. */
export interface PauseExtension {
  /** Correlation, answers nothing: `pauseKeyOf(tenantId, pauseId)`. */
  readonly pauseKey: string;
  /** The new deadline (ISO 8601). */
  readonly expiresAt: string;
  /** The deadline it had (ISO 8601). */
  readonly previousExpiresAt: string;
}
