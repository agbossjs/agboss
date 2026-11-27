import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import { assertValidInstant } from "./instants.js";

/**
 * Every time of a pause answer a store is about to keep (#1307, G3): an Invalid Date is `null` in the
 * JSON and throws in `toISOString()`, so it is refused before any write (`StoreError.UnreadableRecord`
 * naming the field, never the value).
 */
export function assertAnswerInstants(
  answer: Pick<PauseAnswerRecord, "askedAt" | "resolvedAt" | "trail">,
): void {
  assertValidInstant(answer.askedAt, "askedAt", "pause answer");
  assertValidInstant(answer.resolvedAt, "resolvedAt", "pause answer");
  for (const [index, entry] of answer.trail.entries()) {
    assertValidInstant(entry.at, `trail[${String(index)}].at`, "pause answer");
    assertValidInstant(entry.expiresAt, `trail[${String(index)}].expiresAt`, "pause answer");
  }
}
