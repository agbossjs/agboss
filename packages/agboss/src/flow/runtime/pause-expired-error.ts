import { AGBossError } from "../../core/errors.js";
import { StepFailedError, stepCoordinatesOf } from "../../graph/errors.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { ExpiryProblem, PauseKind } from "../../infrastructure/pause-record.js";
import { ComponentKind } from "./records.js";

/**
 * The deadline of a pause passed (#941, D6): the failure of the step that asked — a question step,
 * or the agent whose tool call (or question tool) waited — so `.onError(PauseExpiredError, …)`
 * escalates. Neither error names the pause's id (an error is logged and kept, I14).
 */

/** What an `ExpiryHandlerError` names. */
export interface ExpiryHandlerErrorOptions {
  /** The channel whose expiry decision fell back to `fail()`. */
  readonly channel: string;
  readonly problem: ExpiryProblem;
  /** What went wrong, only in-process (the instance that ran the handler). */
  readonly cause?: unknown;
}

/**
 * Why an expiry decision fell back to `fail()`: the `cause` of its `PauseExpiredError`. The
 * message never holds the handler error's text (it may hold personal data); the `cause` is given
 * only on the instance that ran the handler.
 */
export class ExpiryHandlerError extends AGBossError {
  static override readonly code = "pause.expiry-handler" as const;
  declare readonly code: typeof ExpiryHandlerError.code;
  override name = "ExpiryHandlerError";
  readonly channel: string;
  readonly problem: ExpiryProblem;

  constructor(options: ExpiryHandlerErrorOptions) {
    const { channel, problem, cause } = options;
    super(`channel ${channel}: its expiry decision ${problem}`, {
      cause,
      details: { channel, problem },
    });
    this.channel = channel;
    this.problem = problem;
  }
}

/** What a `PauseExpiredError` names. */
export interface PauseExpiredErrorOptions {
  /** The asking agent or question step. */
  readonly step: string;
  /** Which of the two it is: the fallback coordinates outside a frame. */
  readonly stepKind: ComponentKind.Agent | ComponentKind.Question;
  readonly channel: string;
  readonly kind: PauseKind;
  /** The deadline that passed (ISO 8601). */
  readonly expiresAt: string;
  /** The spend of the failed step (an agent's loop; none for a question). */
  readonly usage: readonly UsageRecord[];
  readonly cause?: unknown;
}

/** The deadline of a pause passed without an answer (D6): `.onError(PauseExpiredError, …)`. */
export class PauseExpiredError extends StepFailedError {
  static override readonly code = "step.pause-expired" as const;
  declare readonly code: typeof PauseExpiredError.code;
  override name = "PauseExpiredError";
  readonly step: string;
  readonly stepKind: ComponentKind.Agent | ComponentKind.Question;
  readonly channel: string;
  readonly kind: PauseKind;
  readonly expiresAt: string;

  constructor(options: PauseExpiredErrorOptions) {
    const { step, stepKind, channel, kind, expiresAt, usage, cause } = options;
    super({
      message: `${step}: its pause on channel ${channel} expired at ${expiresAt}`,
      usage,
      cause,
      ...stepCoordinatesOf(step, stepKind),
      details: { step, stepKind, channel, kind, expiresAt },
    });
    this.step = step;
    this.stepKind = stepKind;
    this.channel = channel;
    this.kind = kind;
    this.expiresAt = expiresAt;
  }
}
