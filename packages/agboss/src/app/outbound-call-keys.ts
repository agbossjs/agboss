import { shortKeyOf } from "../infrastructure/business-key-digest.js";
import { invalidShortKeyLength } from "../infrastructure/idempotency-errors.js";
import type { OutboundCallRecord } from "../infrastructure/outbound-call.repository.js";
import type { CallRun } from "./outbound-call-parts.js";

/** The wire key of a call (#1317d): its prefix, and the one its intent was recorded with. */

/** The first `length` characters of a wire key, 16 to 43 — `IdempotencyError.InvalidKey` else. */
export const shortKeyOrThrow = (key: string, length: number): string => {
  const short = shortKeyOf(key, length);
  if (short === undefined) throw invalidShortKeyLength(length);
  return short;
};

/**
 * `run` with the wire key its intent was recorded with (#1317d): minted once, when the intent was
 * saved, and read back by every retry, reconciliation and replay — a rotated secret would make
 * another, and the other system a second charge.
 */
export const pinnedTo = <TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): CallRun<TRequest, TResult> =>
  found.idempotencyKey === run.idempotencyKey
    ? run
    : { ...run, idempotencyKey: found.idempotencyKey };
