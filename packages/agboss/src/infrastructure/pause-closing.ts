import {
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "./pause-record.js";

/**
 * Why and when a pause closed (#935, #910): the reasons an error and a notice say, derived from the
 * record and never stored, and the one-way key that stands for a pause where its id may not appear.
 */

/** Whether the pause's deadline passed by the record's own resolution: it expired. */
const isExpiredResolution = (resolution: PauseResolution | undefined): boolean =>
  resolution === PauseResolution.Expired || resolution === PauseResolution.DecidedOnExpiry;

/** The reason a resolution closes a pause with; a cancel or tree end that kept an answer is `Answered`. */
const REASON_OF: Readonly<Record<PauseResolution, PauseClosedReason>> = {
  [PauseResolution.Decided]: PauseClosedReason.Answered,
  [PauseResolution.Replied]: PauseClosedReason.Answered,
  [PauseResolution.Withdrawn]: PauseClosedReason.Withdrawn,
  [PauseResolution.Cancelled]: PauseClosedReason.Cancelled,
  [PauseResolution.TreeEnded]: PauseClosedReason.TreeEnded,
  [PauseResolution.Expired]: PauseClosedReason.Expired,
  [PauseResolution.DecidedOnExpiry]: PauseClosedReason.Expired,
  [PauseResolution.Reassigned]: PauseClosedReason.Reassigned,
};

/** Whether a closed record is an answer no step took (a cancel or a tree end that kept its answer). */
const isUntaken = (pause: PauseRecord): boolean =>
  pause.answer !== undefined &&
  (pause.resolution === PauseResolution.Cancelled ||
    pause.resolution === PauseResolution.TreeEnded);

/** Why a record that is not `Pending` closed, by its resolution (stored before them: by its status). */
export function closedReasonOf(pause: PauseRecord): PauseClosedReason {
  if (pause.closedFirst !== undefined) return REASON_OF[pause.closedFirst.resolution];
  if (pause.resolution === undefined)
    return pause.status === PauseStatus.Cancelled
      ? PauseClosedReason.Cancelled
      : PauseClosedReason.Answered;
  return isUntaken(pause) ? PauseClosedReason.Answered : REASON_OF[pause.resolution];
}

/**
 * Why `pause` closed at `now`: `undefined` while it is `Pending` and its deadline is not over. A
 * `Pending` pause past `expiresAt` is `Expired` whatever the sweep did yet (I2). Stores call it to
 * write the notice of a close they observed.
 */
export function pauseClosedReasonOf(pause: PauseRecord, now: Date): PauseClosedReason | undefined {
  if (pause.status !== PauseStatus.Pending) return closedReasonOf(pause);
  return pause.expiresAt !== undefined && pause.expiresAt <= now.toISOString()
    ? PauseClosedReason.Expired
    : undefined;
}

/**
 * When `pause` closed: its `expiresAt` for an expiry (D5), else `resolvedAt` — of its first close
 * when an untaken one followed (`closedFirst`); `undefined` while pending.
 */
export const closedAtOf = (pause: PauseRecord): string | undefined => {
  const first = pause.closedFirst ?? pause;
  return isExpiredResolution(first.resolution) ? pause.expiresAt : first.resolvedAt;
};
