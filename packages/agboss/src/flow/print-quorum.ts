import type { Milliseconds } from "../units/index.js";
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

/** `.arbitratedBy(GoodScoreArbiter)`. */
export const arbitratedByLine = (arbiter: ArbiterClass, label: ComponentLabel): string =>
  `.arbitratedBy(${label(arbiter)})`;

/** `{ min: 2, max: 3, deadline: seconds(30) }`, as written. */
export function countQuorumOptions(quorum: CountQuorum): string {
  const options = [
    `min: ${String(quorum.min)}`,
    ...(quorum.max === undefined ? [] : [`max: ${String(quorum.max)}`]),
    ...(quorum.deadline === undefined ? [] : [`deadline: ${durationText(quorum.deadline)}`]),
  ];
  return `{ ${options.join(", ")} }`;
}

/** `{ deadline: minutes(1) }` of `.joinQuorumGroups({ deadline })`; undefined without one. */
export const groupsQuorumOptions = (quorum: GroupsQuorum): string | undefined =>
  quorum.deadline === undefined ? undefined : `{ deadline: ${durationText(quorum.deadline)} }`;

/** Whether a join is `.joinQuorumGroups(…)`. */
export const isGroupsQuorum = (
  quorum: CountQuorum | GroupsQuorum | undefined,
): quorum is GroupsQuorum => quorum?.kind === QuorumKind.Groups;
