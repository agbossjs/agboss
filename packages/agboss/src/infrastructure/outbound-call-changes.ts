import type {
  OutboundCallClaim,
  OutboundCallEnding,
  OutboundCallRecord,
  OutboundCallState,
} from "./outbound-call-record.js";
import type { OutboundCallStatus } from "./outbound-call.repository.js";

/**
 * How a store changes an intent (#505, #508, #658), as plain functions on its record — the
 * in-memory and SQLite stores apply them inside their fenced step; a store of SQL repeats them in
 * its `UPDATE … WHERE`. No value import of the store module (a cycle at load): the status values
 * are its enum's.
 */

const PENDING = "pending" as OutboundCallStatus.Pending;

/** Whether `found` is still as `expected`. */
export const isInState = (found: OutboundCallRecord, expected: OutboundCallState): boolean =>
  found.status === expected.status &&
  found.attempt === expected.attempt &&
  found.attemptOwner === expected.attemptOwner;

/**
 * `found` moved to `claim` — `Pending`, its new attempt started at `startedAt` (#658) — only while
 * it is still as `expected`; `undefined` otherwise.
 */
export const claimedOf = (
  found: OutboundCallRecord,
  expected: OutboundCallState,
  claim: OutboundCallClaim,
  startedAt: Date,
): OutboundCallRecord | undefined =>
  isInState(found, expected)
    ? {
        ...withoutEnd(found),
        status: PENDING,
        ...claim,
        attemptStartedAt: startedAt.toISOString(),
      }
    : undefined;

/** A record without its last ending (`result`, `failure`, `endedAt`): sent again, or ending now. */
export function withoutEnd(found: OutboundCallRecord): OutboundCallRecord {
  const record = { ...found };
  delete record.result;
  delete record.failure;
  delete record.endedAt;
  return record;
}

/** `found` ended as `ending` at `endedAt` — only while it is pending and `attemptOwner` owns it. */
export const endedOf = (
  found: OutboundCallRecord,
  attemptOwner: string,
  ending: OutboundCallEnding,
  endedAt: string,
): OutboundCallRecord | undefined =>
  found.attemptOwner === attemptOwner && found.status === PENDING
    ? { ...withoutEnd(found), ...ending, endedAt }
    : undefined;
