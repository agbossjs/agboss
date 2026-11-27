import { assertValidInstant } from "./instants.js";
import type { PauseRecord } from "./pause-record.js";

/**
 * Every time of a pause a store is about to keep (#1307, G3): an Invalid Date in any of them is
 * refused before anything is written (`assertValidInstant`: `StoreError.UnreadableRecord` naming the
 * field), so no store holds a pause it cannot read back or compare. The three raw columns, the JSON and
 * the in-memory record are all covered: it is called once, over the record as it will be written.
 */
export function assertPauseInstants(pause: PauseRecord): void {
  assertValidInstant(pause.askedAt, "askedAt");
  assertValidInstant(pause.firstAskedAt, "firstAskedAt");
  assertValidInstant(pause.maxExpiresAt, "maxExpiresAt");
  assertValidInstant(pause.resolvedAt, "resolvedAt");
  assertValidInstant(pause.expiresAt, "expiresAt");
  assertValidInstant(pause.remindAt, "remindAt");
  assertValidInstant(pause.boundAt, "boundAt");
  assertValidInstant(pause.closedFirst?.resolvedAt, "closedFirst.resolvedAt");
  for (const [index, entry] of pause.trail.entries()) {
    assertValidInstant(entry.at, `trail[${String(index)}].at`);
    assertValidInstant(entry.expiresAt, `trail[${String(index)}].expiresAt`);
  }
}
