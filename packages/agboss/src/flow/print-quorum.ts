import { isWorkingDuration, type Milliseconds, type WorkingDuration } from "../units/index.js";
import type { TimeSpan } from "../units/working-time.js";
import { QuorumKind, type ArbiterClass, type CountQuorum, type GroupsQuorum } from "./ast.js";
import type { ComponentLabel } from "./print.js";

/**
 * How the printout writes a quorum (#279): `.arbitratedBy(A)`, the
 * options of `.joinQuorum({ min, max, deadline })` and `.joinQuorumGroups({ deadline })`, a
 * deadline in the unit it reads best in (`seconds(30)`, `minutes(2)`, `hours(1)`).
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A duration as the units write it. */
export function durationText(duration: Milliseconds): string {
  if (duration % HOUR === 0) return `hours(${String(duration / HOUR)})`;
  if (duration % MINUTE === 0) return `minutes(${String(duration / MINUTE)})`;
  return `seconds(${String(duration / 1000)})`;
}

/** Working time as the units write it: `workDays(5)`, `workHours(2)`, `workMin(30)`. */
function workingText(duration: WorkingDuration): string {
  if (duration.unit === "days") return `workDays(${String(duration.amount)})`;
  if (duration.amount % HOUR === 0) return `workHours(${String(duration.amount / HOUR)})`;
  return `workMin(${String(duration.amount / MINUTE)})`;
}

/** A deadline as written, plain or working (#1306). */
const spanText = (span: TimeSpan): string =>
  isWorkingDuration(span) ? workingText(span) : durationText(span);

/** `deadline: …` and, for working time, `calendar: Name`. */
function deadlineOptions(quorum: CountQuorum | GroupsQuorum, label: ComponentLabel): string[] {
  if (quorum.deadline === undefined) return [];
  return [
    `deadline: ${spanText(quorum.deadline)}`,
    ...(quorum.calendar === undefined ? [] : [`calendar: ${label(quorum.calendar)}`]),
  ];
}

/** `.arbitratedBy(GoodScoreArbiter)`. */
export const arbitratedByLine = (arbiter: ArbiterClass, label: ComponentLabel): string =>
  `.arbitratedBy(${label(arbiter)})`;

/** `{ min: 2, max: 3, deadline: seconds(30) }`, as written. */
export function countQuorumOptions(quorum: CountQuorum, label: ComponentLabel): string {
  const options = [
    `min: ${String(quorum.min)}`,
    ...(quorum.max === undefined ? [] : [`max: ${String(quorum.max)}`]),
    ...deadlineOptions(quorum, label),
  ];
  return `{ ${options.join(", ")} }`;
}

/** `{ deadline: minutes(1) }` of `.joinQuorumGroups({ deadline })`; undefined without one. */
export const groupsQuorumOptions = (
  quorum: GroupsQuorum,
  label: ComponentLabel,
): string | undefined =>
  quorum.deadline === undefined ? undefined : `{ ${deadlineOptions(quorum, label).join(", ")} }`;

/** Whether a join is `.joinQuorumGroups(…)`. */
export const isGroupsQuorum = (
  quorum: CountQuorum | GroupsQuorum | undefined,
): quorum is GroupsQuorum => quorum?.kind === QuorumKind.Groups;
