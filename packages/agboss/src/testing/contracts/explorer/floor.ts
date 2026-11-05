import { describe, it } from "vitest";
import type { InterleavingOptions } from "./register.js";

/**
 * The explorer's budget, bounded (#799): its defaults, the floor a set with payment-grade fencing
 * is explored at, and the one skipped case of a set that turns it off — what a search did not
 * cover is shown, never a pass.
 */

/** The budget the explorer runs at when the set gives none of a field. */
export const INTERLEAVING_DEFAULTS = { depth: 8, walks: 200, walkDepth: 30 } as const;

/**
 * The least budget a set with a fenced-effect or outbound-call store — payment-grade fencing — is
 * explored at (#799): below it a search can pass without reaching the races it is there for.
 */
export const INTERLEAVING_FLOOR = { depth: 4, walks: 20, walkDepth: 16 } as const;

/** The floor, said: "depth ≥ 4, walks ≥ 20, walkDepth ≥ 16". */
export const FLOOR_TEXT = Object.entries(INTERLEAVING_FLOOR)
  .map(([key, least]) => `${key} ≥ ${String(least)}`)
  .join(", ");

/** What of `options` is below the floor (`interleavings: false`: everything); none when it is not. */
export function belowFloorOf(options: InterleavingOptions | false): readonly string[] {
  if (options === false) return ["interleavings: false explores nothing"];
  return Object.entries(INTERLEAVING_FLOOR).flatMap(([key, least]) => {
    const field = key as keyof typeof INTERLEAVING_FLOOR;
    const given = options[field] ?? INTERLEAVING_DEFAULTS[field];
    return given < least ? [`${field} ${String(given)} < ${String(least)}`] : [];
  });
}

/** The skipped case of a set that turns the explorer off (#799): a report shows what was not explored. */
export const NOT_EXPLORED_CASE = "not explored: the set gives interleavings: false";

/** Registers `interleavings (<name>)` with its one skipped case, for a set that turns it off. */
export function registerInterleavingsOff(name: string): void {
  describe(`interleavings (${name})`, () => {
    it(NOT_EXPLORED_CASE, (context) => {
      context.skip("interleavings: false — no schedule of these stores was searched");
    });
  });
}
