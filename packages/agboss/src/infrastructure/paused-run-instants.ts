import type { PausedExecution } from "../app/paused-runs.js";
import { assertValidInstant } from "./instants.js";

/**
 * The times a paused run keeps (#1307, G3): each pending pause's `expiresAt`. An Invalid Date there is
 * written as `null` in the run's JSON and every later read refuses the row, so a store refuses it
 * before it writes anything (`StoreError.UnreadableRecord`, naming the field, never the value).
 */
export function assertPausedRunInstants(paused: PausedExecution): void {
  for (const [index, pending] of paused.run.pending.entries())
    assertValidInstant(pending.expiresAt, `pending[${String(index)}].expiresAt`, "paused run");
}
