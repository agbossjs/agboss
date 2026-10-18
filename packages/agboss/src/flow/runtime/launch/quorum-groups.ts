import type { CountedAnswer, QuorumOutcome } from "./quorum.js";

/**
 * The groups of `.joinQuorumGroups(…)` (#279 AC7): a group is complete when every one of its places
 * is taken by a counted answer — a repeated agent is that many copies, any of them. Priority 1 is the
 * highest; equal numbers (or none) are equal groups, the first completed wins, and one answer
 * completing two groups gives the higher one. While a higher group can still complete the quorum
 * waits; no group able to complete any more decides it at once (not reached).
 */

/** One group's places: its agents by node name as listed (repeats included), its priority. */
export interface GroupPlaces {
  readonly agents: readonly string[];
  readonly priority?: number;
}

const rankOf = (group: GroupPlaces): number => group.priority ?? Number.POSITIVE_INFINITY;

/** How many times each name occurs. */
export function tally(names: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/** How many copies of each agent a group needs. */
const needsOf = (group: GroupPlaces): ReadonlyMap<string, number> => tally(group.agents);

const countOf = (counts: ReadonlyMap<string, number>, node: string): number =>
  counts.get(node) ?? 0;

/** Every place of the group taken by a counted answer. */
function isComplete(group: GroupPlaces, counts: ReadonlyMap<string, number>): boolean {
  return [...needsOf(group)].every(([node, copies]) => countOf(counts, node) >= copies);
}

/** The group is complete, or the branches still running can complete it. */
function canComplete(
  group: GroupPlaces,
  counts: ReadonlyMap<string, number>,
  pending: ReadonlyMap<string, number>,
): boolean {
  return [...needsOf(group)].every(
    ([node, copies]) => countOf(counts, node) + countOf(pending, node) >= copies,
  );
}

/**
 * Whether the groups' outcome is fixed: a complete group no higher group can still overtake, no
 * group able to complete, or no branch left.
 */
export function isGroupsDecided(
  groups: readonly GroupPlaces[],
  counts: ReadonlyMap<string, number>,
  pending: ReadonlyMap<string, number>,
): boolean {
  if ([...pending.values()].every((count) => count === 0)) return true;
  const ranks = groups.filter((group) => isComplete(group, counts)).map(rankOf);
  if (ranks.length === 0) return !groups.some((group) => canComplete(group, counts, pending));
  const best = Math.min(...ranks);
  return !groups.some((group) => rankOf(group) < best && canComplete(group, counts, pending));
}

/** At which counted answer (its `acceptedSequence`) each group completed; Infinity: never. */
function completionsOf(
  groups: readonly GroupPlaces[],
  counted: readonly CountedAnswer[],
): readonly number[] {
  const completed = groups.map(() => Number.POSITIVE_INFINITY);
  const counts = new Map<string, number>();
  for (const answer of counted) {
    counts.set(answer.node, countOf(counts, answer.node) + 1);
    groups.forEach((group, index) => {
      if (completed[index] === Number.POSITIVE_INFINITY && isComplete(group, counts))
        completed[index] = answer.acceptedSequence;
    });
  }
  return completed;
}

/** The winner: the highest priority, then the first completed, then the first listed. */
function winnerOf(
  groups: readonly GroupPlaces[],
  completed: readonly number[],
): number | undefined {
  const candidates = groups
    .map((group, index) => ({ index, rank: rankOf(group), at: completed[index] ?? Infinity }))
    .filter((candidate) => candidate.at !== Number.POSITIVE_INFINITY)
    .sort((first, second) => first.rank - second.rank || first.at - second.at);
  return candidates[0]?.index;
}

/** The groups' outcome from the counted answers: the winner and its agents' counted answers. */
export function groupOutcomeOf(
  groups: readonly GroupPlaces[],
  counted: readonly CountedAnswer[],
): QuorumOutcome {
  const winner = winnerOf(groups, completionsOf(groups, counted));
  const group = winner === undefined ? undefined : groups[winner];
  if (winner === undefined || group === undefined) return { isReached: false, counted };
  const agents = new Set(group.agents);
  const own = counted.filter((answer) => agents.has(answer.node));
  return { isReached: true, counted: own, group: winner };
}
