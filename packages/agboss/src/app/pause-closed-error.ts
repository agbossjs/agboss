import { AGBossError } from "../core/errors.js";
import { pauseKeyOf, type PauseClosedReason } from "../infrastructure/pause-record.js";

/** What a `PauseClosedError` is made from (#939); `cause` is the usual optional one. */
export interface PauseClosedErrorOptions {
  /** The pause the caller answered: the id they passed (a closed pause's id answers nothing). */
  readonly pauseId: string;
  /** The tenant that has the pause: with the id it makes the `pauseKey` the message names. */
  readonly tenantId: string;
  /** Why it closed. */
  readonly reason: PauseClosedReason;
  /** When it closed (ISO 8601). */
  readonly closedAt: string;
  readonly cause?: unknown;
}

/**
 * `app.resume` of a pause that is closed: answered already, expired, cancelled, withdrawn, its tree
 * ended or moved to someone else (#910, #939) — the reason and when. The message names the pause by
 * its `pauseKey`, never its id (a message is logged and observed, I14). A thread with no paused run
 * at all is `NotPausedError`.
 */
export class PauseClosedError extends AGBossError {
  static override readonly code = "pause.closed" as const;
  declare readonly code: typeof PauseClosedError.code;
  override name = "PauseClosedError";
  readonly pauseId: string;
  readonly tenantId: string;
  readonly reason: PauseClosedReason;
  readonly closedAt: string;

  constructor(options: PauseClosedErrorOptions) {
    const { pauseId, tenantId, reason, closedAt, cause } = options;
    const key = pauseKeyOf(tenantId, pauseId);
    super(`pause ${key} is closed: ${reason} at ${closedAt}`, {
      cause,
      details: { reason, closedAt },
    });
    this.pauseId = pauseId;
    this.tenantId = tenantId;
    this.reason = reason;
    this.closedAt = closedAt;
  }
}

/**
 * `app.extendPause` lost its compare-and-set to other writers on every attempt (#1099): the pause's
 * deadline moved under each try (other extensions) while it stayed open. Nothing was changed by the
 * call; retrying `extendPause` is safe. `attempts` is how many it made.
 */
export class PauseExtensionContendedError extends AGBossError {
  static override readonly code = "pause.extension-contended" as const;
  declare readonly code: typeof PauseExtensionContendedError.code;
  override name = "PauseExtensionContendedError";
  readonly pauseKey: string;
  readonly attempts: number;

  constructor(options: PauseExtensionContendedErrorOptions) {
    const { pauseKey, attempts, cause } = options;
    super(
      `extendPause of pause ${pauseKey} lost its compare-and-set ${String(attempts)} times to other writers`,
      { cause, details: { attempts } },
    );
    this.pauseKey = pauseKey;
    this.attempts = attempts;
  }
}

/** What a `PauseExtensionContendedError` is made from (#1099). */
export interface PauseExtensionContendedErrorOptions {
  /** The pause's `pauseKey` (a message is logged and observed: never its bare id, I14). */
  readonly pauseKey: string;
  /** How many times the call read and tried. */
  readonly attempts: number;
  readonly cause?: unknown;
}
