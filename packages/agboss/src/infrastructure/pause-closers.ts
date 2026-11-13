import {
  PauseResolution,
  PauseStatus,
  type ExpiryProblem,
  type PauseAnswer,
  type PauseRecord,
  type PauseUntakenResolution,
} from "./pause-record.js";

/** The records the closers of a pause make beyond a resolve, a decision and a cancel (#935). */

/** The pause whose deadline passed with no answer: `Cancelled`, `Expired`, why it fell back to fail. */
export const expiredPause = (
  pause: PauseRecord,
  at: Date,
  problem: ExpiryProblem | undefined,
): PauseRecord => ({
  ...pause,
  status: PauseStatus.Cancelled,
  resolution: PauseResolution.Expired,
  resolvedAt: at.toISOString(),
  ...(problem === undefined ? {} : { expiryProblem: problem }),
});

/** The pause whose deadline passed and whose channel decided: `Resolved`, `DecidedOnExpiry`. */
export const decidedOnExpiryPause = (
  pause: PauseRecord,
  answer: PauseAnswer,
  at: Date,
): PauseRecord => ({
  ...pause,
  status: PauseStatus.Resolved,
  answer: { ...answer, answeredBy: undefined },
  resolution: PauseResolution.DecidedOnExpiry,
  resolvedAt: at.toISOString(),
});

/**
 * The answered pause whose answer no step took: `Cancelled`, the answer kept, and how and when it
 * first closed kept in `closedFirst`: the untaken close adds its marker and never overwrites them.
 */
export const untakenPause = (
  pause: PauseRecord,
  resolution: PauseUntakenResolution,
  at: Date,
): PauseRecord => ({
  ...pause,
  status: PauseStatus.Cancelled,
  resolution,
  resolvedAt: at.toISOString(),
  ...(pause.resolution === undefined || pause.resolvedAt === undefined
    ? {}
    : { closedFirst: { resolution: pause.resolution, resolvedAt: pause.resolvedAt } }),
});
