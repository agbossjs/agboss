import { expect } from "vitest";
import { systemClock } from "../../../infrastructure/clock.js";
import { scheduleText, type SearchBudget, type SearchReport } from "./search.js";

/**
 * How an explorer case ends (#533, #590): a violation's printed schedule, a search that stopped
 * before it was done — its counts, what was left, why —, or its counts logged.
 */

/** A schedule that broke an invariant: its message is the printed minimal schedule. */
export class InterleavingViolationError extends Error {
  override name = "InterleavingViolationError";
}

/** Fails with the printed schedule when `report` found a violation. */
/** A search that could not finish (#590): what it explored, what was left, why it stopped. */
export class InterleavingIncompleteError extends Error {
  override name = "InterleavingIncompleteError";
}

/**
 * Fails with the printed schedule when `report` found a violation, and with its counts when it
 * stopped before it was done; logs what it explored either way.
 */
export function expectComplete(name: string, what: string, report: SearchReport): void {
  if (report.violation !== undefined)
    throw new InterleavingViolationError(scheduleText(name, report.violation));
  const counts = `${String(report.schedules)} schedules, ${String(report.states)} states`;
  if (report.stopped !== undefined)
    throw new InterleavingIncompleteError(
      `interleaving explorer (${name}): ${what} stopped after ${counts} because ${report.stopped.reason}; ${String(report.stopped.left)} left unexplored, so nothing beyond them was checked — lower interleavings.depth or walks, or raise interleavings.timeLimit`,
    );
  process.stderr.write(`[interleavings] ${name} · ${what}: ${counts}\n`);
  expect(report.schedules).toBeGreaterThan(0);
}

/** The budget of one case: its vitest signal and its time limit from now. */
export const budgetOf = (
  options: { readonly timeLimit?: number },
  signal: AbortSignal,
): SearchBudget => ({
  signal,
  deadline: systemClock.now().getTime() + (options.timeLimit ?? DEFAULT_TIME_LIMIT),
});

/** A case's vitest timeout: past its time limit, so the search stops first and says why. */
export const timeoutOf = (options: { readonly timeLimit?: number }): number =>
  (options.timeLimit ?? DEFAULT_TIME_LIMIT) + 120_000;

const DEFAULT_TIME_LIMIT = 480_000;
