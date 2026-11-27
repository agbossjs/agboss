import { copyOf, sameInstant } from "./instants.js";
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
  ...(pause.expiresAt === undefined ? {} : { expiresAt: copyOf(pause.expiresAt) }),
});

/**
 * Whether the pause is still the one the change was permitted and planned against (#1307); a change
 * with no `seen` (a caller that skipped the plan) is never as seen: refused, not a `TypeError`.
 */
export function isAsSeen(pause: PauseRecord, seen: PauseSeen | undefined): boolean {
  if (seen === undefined) return false;
  return (
    pause.trail.length === seen.trailLength &&
    sameInstant(pause.expiresAt, seen.expiresAt) &&
    pause.isSent === seen.isSent &&
    sameAssignees(pause.assignees, seen.assignees)
  );
}

/** `isAsSeen` under its other name: whether the pause is still the one `seen` names. */
export const isSeenAs = isAsSeen;
