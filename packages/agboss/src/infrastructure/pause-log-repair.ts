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
 * Writes the log entry of every closed pause the retention removes, then removes them: the store's
 * listing is read whole, page by page by its cursor — a backlog of any size, closed in one
 * millisecond or not — before the one removal, so no close goes before its entry is written. A
 * listing that fails removes nothing; the next sweep reads it again.
 */
export async function removeClosedPauses(
  pauses: Pick<
    PausedExecutionRepository,
    "findClosedByResolvedAtBefore" | "deleteByResolvedAtBefore"
  >,
  log: PauseAnswerLog,
  cutoff: Date,
): Promise<void> {
  let after: string | undefined;
  do {
    const page = await pauses.findClosedByResolvedAtBefore(cutoff, REPAIR_PAGE, after);
    for (const pause of page.pauses) await repaired(log, pause);
    after = page.next;
  } while (after !== undefined);
  await pauses.deleteByResolvedAtBefore(cutoff);
}
