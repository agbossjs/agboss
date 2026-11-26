import type { ExecutionPauseRecord, PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { PauseTrailEntry } from "../channels/pause-contexts.js";
import { earlierOf, isBefore, sameInstant } from "./instants.js";
import type { PauseTrailRecord } from "./pause-record.js";

/**
 * THE BOUNDARY of a pause's times (#1307, G3): `PauseRecord`, `PauseNotice` and everything of the
 * `@agboss/core/stores` contract still hold ISO 8601 texts; every public surface of the core (events,
 * `ListedPause`, `result.pending`, the answer log, `PauseError.Closed`) holds `Date`s. The texts become
 * dates here and nowhere else.
 *
 * P6b types the record and the store contract as `Date`s and deletes this module: every caller of
 * `instantOf` / `trailEntryOf` then passes the record's own value.
 */

/** The instant an ISO 8601 text the record kept names. */
export const instantOf = (text: string): Date => new Date(text);

/** `instantOf` of a time that may be absent. */
export const instantOfOptional = (text: string | undefined): Date | undefined =>
  text === undefined ? undefined : instantOf(text);

/** One step of a chain of custody as the record keeps it, with its times as dates. */
export const trailEntryOf = (record: PauseTrailRecord): PauseTrailEntry => {
  const { at, expiresAt, ...rest } = record;
  return {
    ...rest,
    at: instantOf(at),
    ...(expiresAt === undefined ? {} : { expiresAt: instantOf(expiresAt) }),
  };
};

/** `trailEntryOf` for the whole chain. */
export const trailEntriesOf = (trail: readonly PauseTrailRecord[]): readonly PauseTrailEntry[] =>
  trail.map(trailEntryOf);

/** Whether a deadline the record kept is at or before `now`; no deadline is never due. */
export const isDueAt = (expiresAt: string | undefined, now: Date): boolean =>
  expiresAt !== undefined && !isBefore(now, instantOf(expiresAt));

/** Whether the record's time `a` is strictly before `b`: by instant, never by the texts' order. */
export const isBeforeText = (a: string, b: string): boolean => isBefore(instantOf(a), instantOf(b));

/** Whether two times of records name the same instant; two absent ones do. */
export const sameInstantText = (a: string | undefined, b: string | undefined): boolean =>
  sameInstant(instantOfOptional(a), instantOfOptional(b));

/** The earlier of two times of records, as the record keeps it (`a` when they are the same instant). */
export const earlierText = (a: string, b: string): string => {
  const first = instantOf(a);
  return earlierOf(first, instantOf(b)) === first ? a : b;
};

/** The order of two times of records by instant (for `sort`): negative when `a` is earlier. */
export const compareText = (a: string, b: string): number =>
  instantOf(a).getTime() - instantOf(b).getTime();

/** A resolved pause the answer log keeps (texts) as `result.record.pauses` shows it (`Date`s). */
export const executionPauseOf = (answer: PauseAnswerRecord): ExecutionPauseRecord => ({
  ...answer,
  askedAt: instantOf(answer.askedAt),
  resolvedAt: instantOfOptional(answer.resolvedAt),
  trail: trailEntriesOf(answer.trail),
});
