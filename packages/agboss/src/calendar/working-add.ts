import type { WorkingDuration } from "../units/index.js";
import type { Grid } from "./working-grid.js";
import { walkDays, walkMilliseconds, type Direction } from "./working-walk.js";

/**
 * The instant a working duration after (before) `from` over the grids of one calendar (#1310b).
 * Working milliseconds are counted over the union of the grids, so overlapping hours of two
 * regions are never counted twice. Working days are counted on each grid by its own zone's local
 * dates — a shift is never split at 00:00Z — and the answer is the earliest across the grids when
 * walking forward and the latest when walking back (a reminder is never earlier than one grid's).
 * Grids that cannot answer (no working time ahead, past the day limit) are left out; the walk fails
 * only when none can.
 */
export function workingInstant(
  grids: readonly Grid[],
  from: number,
  duration: WorkingDuration,
  direction: Direction,
): number {
  if (duration.unit === "ms") return walkMilliseconds(grids, from, duration.amount, direction);
  const answers: number[] = [];
  let failure: unknown;
  for (const grid of grids) {
    try {
      answers.push(walkDays(grid, from, duration.amount, direction));
    } catch (error) {
      failure ??= error;
    }
  }
  if (answers.length === 0)
    throw failure instanceof Error ? failure : new RangeError("the calendar has no schedule");
  return direction === 1 ? Math.min(...answers) : Math.max(...answers);
}
