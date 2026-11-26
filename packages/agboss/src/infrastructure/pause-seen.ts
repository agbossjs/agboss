import type { PauseSeen } from "./pause-notices.js";
import type { PauseRecord } from "./pause-record.js";

/** What a change of a pause is planned against, and whether the pause is still that (#1307). */

const sameAssignees = (
  one: readonly string[] | undefined,
  other: readonly string[] | undefined,
): boolean =>
  one === undefined || other === undefined
    ? one === other
    : one.length === other.length && one.every((key, index) => key === other[index]);

/** What a change is planned against: the store applies it only while the pause is still this (#1307). */
export const seenOf = (pause: PauseRecord): PauseSeen => ({
  trailLength: pause.trail.length,
  isSent: pause.isSent,
  ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
  ...(pause.expiresAt === undefined ? {} : { expiresAt: pause.expiresAt }),
});

/** Whether the pause is still the one the change was permitted and planned against (#1307). */
export const isAsSeen = (pause: PauseRecord, seen: PauseSeen): boolean =>
  pause.trail.length === seen.trailLength &&
  pause.expiresAt === seen.expiresAt &&
  pause.isSent === seen.isSent &&
  sameAssignees(pause.assignees, seen.assignees);

/** Whether the pause is still the one `seen` names; a change without one is never as seen. */
export const isSeenAs = (pause: PauseRecord, seen: PauseSeen | undefined): boolean =>
  seen !== undefined && isAsSeen(pause, seen);
