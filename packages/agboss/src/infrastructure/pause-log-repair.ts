import type { PauseAnswerLog } from "./pause-answer-log.js";
import { logPauseNotTaken } from "./pause-answer-log.js";
import { logPauseAnswer, PauseResolution, PauseStatus, type PauseRecord } from "./pause-record.js";
import type { PausedExecutionRepository } from "./paused-execution.repository.js";

/**
 * Before a closed pause's record is removed by retention, its answer-log entry is written if a crash
 * lost it (#939, #910 I11): the log is complete even after a death between a close and its write.
 */

/** How many closed pauses one listing reads. */
export const REPAIR_PAGE = 1000;

/** Whether a closed record is an answer no step took (a cancel or a tree end that kept its answer). */
const isUntaken = (pause: PauseRecord): boolean =>
  pause.status === PauseStatus.Cancelled &&
  pause.answer !== undefined &&
  (pause.resolution === PauseResolution.Cancelled ||
    pause.resolution === PauseResolution.TreeEnded);

/** Writes the pause's entry; one already there is left as it is (the store ignores a second write). */
function repaired(log: PauseAnswerLog, pause: PauseRecord): Promise<void> {
  if (isUntaken(pause)) return logPauseNotTaken(log, pause);
  const fallback =
    pause.status === PauseStatus.Cancelled ? PauseResolution.Cancelled : PauseResolution.Replied;
  return logPauseAnswer(log, pause, pause.resolution ?? fallback);
}

/**
 * Writes the log entry of every closed pause the retention removes, then removes them. The store
 * lists at most `REPAIR_PAGE` and has no cursor, so a backlog over one listing is taken newest-first
 * by moving the cutoff to just past the newest time listed: what is removed is what was listed
 * (the one removal is by that cutoff), whatever the store's order. A cutoff that cannot move — more
 * than a page of closes in one millisecond — removes that millisecond's closes after the first page
 * was written: the retention's bound beats an entry a crash lost twice over.
 */
export async function removeClosedPauses(
  pauses: Pick<
    PausedExecutionRepository,
    "findClosedByResolvedAtBefore" | "deleteByResolvedAtBefore"
  >,
  log: PauseAnswerLog,
  cutoff: Date,
): Promise<void> {
  let bound = cutoff;
  for (;;) {
    const listed = await pauses.findClosedByResolvedAtBefore(bound, REPAIR_PAGE);
    for (const pause of listed) await repaired(log, pause);
    if (listed.length < REPAIR_PAGE) break;
    const times = listed.map((pause) => Date.parse(pause.resolvedAt ?? "")).filter(Number.isFinite);
    // a closed record always has its time; with none readable nothing is removed, never unlogged
    if (times.length === 0) return;
    const narrower = new Date(Math.max(...times) + 1);
    if (narrower.getTime() >= bound.getTime()) break;
    bound = narrower;
  }
  await pauses.deleteByResolvedAtBefore(bound);
}
