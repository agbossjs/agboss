import type { UsageRecord } from "../../../finops/usage.js";
import { StepFailedError, stepCoordinatesOf, type StepCoordinates } from "../../../graph/errors.js";
import { ComponentKind } from "../records.js";

/**
 * The two failures of a quorum (#279): an arbiter could not judge an answer (`ArbiterError`) — not a
 * rejection, it fails the launch — and the quorum was not reached (`QuorumNotReachedError`): too few
 * answers counted, or no group complete, by the deadline or once it could no longer be. Both are
 * step failures (`StepFailedError`), taken by `.onJoinError(E, …)` right after the join; without
 * one the execution fails.
 */

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** What an arbiter that could not judge takes (#906). */
export interface ArbiterErrorOptions {
  /** The arbiter's `name` (`valid-score-arbiter`). */
  readonly arbiter: string;
  readonly usage?: readonly UsageRecord[];
  /** What the arbiter threw, or why its model did not answer. */
  readonly cause?: unknown;
}

/**
 * An arbiter threw, or its model did not answer (#279 AC12): the branch's step fails with it, the
 * original error as its `cause`; the launch's other branches are cancelled.
 */
export class ArbiterError extends StepFailedError {
  static override readonly code = "step.arbiter" as const;
  declare readonly code: typeof ArbiterError.code;
  override name = "ArbiterError";
  /** The arbiter's `name` (`valid-score-arbiter`). */
  readonly arbiter: string;

  constructor(options: ArbiterErrorOptions) {
    const { arbiter, usage = [], cause } = options;
    const step = stepCoordinatesOf(arbiter, ComponentKind.Arbiter);
    const message = `Arbiter "${arbiter}" failed on the answer of ${step.nodeId}: ${describe(cause)}`;
    super({ message, usage, cause, ...step, details: { arbiter } });
    this.arbiter = arbiter;
  }
}

/** How far a quorum got: what it needed and what it counted. */
export interface QuorumShortfall {
  /** `.joinQuorum({ min })`; undefined for `.joinQuorumGroups(…)`. */
  readonly min?: number | undefined;
  /** How many answers were counted. */
  readonly counted: number;
  /** Why it stopped: `the deadline passed`, `min can no longer be reached`, … */
  readonly reason: string;
}

/** What a quorum that was not reached takes (#906): the launch, its step and the shortfall. */
export interface QuorumNotReachedErrorOptions extends QuorumShortfall, StepCoordinates {
  /** The launch: `${executionId}:${nodeId}:${visitNumber}` of the launching step. */
  readonly launch: string;
  readonly cause?: unknown;
}

/**
 * The quorum of a launch was not reached (#279 AC2, AC3, AC7): fewer than `min` answers counted, or
 * no group complete — at the deadline, or at once when it could no longer be. It names the
 * launching step.
 */
export class QuorumNotReachedError extends StepFailedError {
  static override readonly code = "step.quorum" as const;
  declare readonly code: typeof QuorumNotReachedError.code;
  override name = "QuorumNotReachedError";
  /** The launch: `${executionId}:${nodeId}:${visitNumber}` of the launching step. */
  readonly launch: string;
  /** `.joinQuorum({ min })`; undefined for `.joinQuorumGroups(…)`. */
  readonly min: number | undefined;
  /** How many answers were counted. */
  readonly counted: number;
  /** Why it stopped: `the deadline passed`, `min can no longer be reached`, … */
  readonly reason: string;

  constructor(options: QuorumNotReachedErrorOptions) {
    const { launch, min, counted, reason, cause, ...step } = options;
    const needed = min === undefined ? "no group complete" : `need ${String(min)}`;
    const message = `The quorum of ${step.nodeId}'s launch was not reached: ${String(counted)} counted, ${needed} — ${reason}`;
    super({
      message,
      usage: [],
      cause,
      ...step,
      details: { launch, counted, ...(min === undefined ? {} : { min }) },
    });
    this.launch = launch;
    this.min = min;
    this.counted = counted;
    this.reason = reason;
  }
}
