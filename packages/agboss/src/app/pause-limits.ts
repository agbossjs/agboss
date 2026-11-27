import { copyOf } from "../infrastructure/instants.js";
import { definedFields } from "../core/defined-fields.js";
import { PauseError } from "../core/error-families/pause-errors.js";
import type { PauseTarget } from "../flow/runtime/pause-channel.js";
import { instantAfter } from "../flow/runtime/pause-record-made.js";
import {
  narrowedLimits,
  type PauseEscalationCounts,
  type PauseLimitsOffer,
} from "../infrastructure/pause-limits-stored.js";
import { pauseKeyOf, type PauseRecord } from "../infrastructure/pause-record.js";
import { calendarOfTarget, type CalendarParts } from "./pause-calendar.js";

/**
 * The escalation limits of a pause (#1307, Q-D): the record's own — materialized when it was opened
 * (`maxExpiresAt`, `escalationLimits`) and narrowed, never loosened, by each move to another target.
 * Never recomputed from the application's present configuration: a deploy that renamed or removed a
 * target, or loosened its limits, changes nothing for a pause already waiting. The total wait counts
 * from the pause's first asking (`firstAskedAt`), never from a reassignment. The counts
 * (`maxExtensions`, `maxReassignments`) are checked by the store atomically with the write too.
 */

/** What a pause's chain allows: the record's limits, or those after a move. */
export interface ChainLimits extends PauseEscalationCounts {
  /** The latest instant the pause may wait until ; absent: no limit on the total wait. */
  readonly maxExpiresAt: Date | undefined;
}

/** The limits of `pause` as it holds them, optionally after taking what a destination `offer`s. */
export function limitsOf(pause: PauseRecord, offer?: PauseLimitsOffer): ChainLimits {
  const { maxExpiresAt, escalationLimits } = narrowedLimits(pause, offer);
  return { ...escalationLimits, maxExpiresAt };
}

/** The counts the destination `to` offers (a move to another target narrows the pause's by them). */
export const countsOffered = (to: PauseTarget): PauseLimitsOffer => ({
  escalationLimits: definedFields({
    maxExtensions: to.escalationLimits?.maxExtensions,
    maxReassignments: to.escalationLimits?.maxReassignments,
  }),
});

/**
 * What the destination `to` offers of limits: its counts, and the instant its `maxTotalTimeout`
 * runs out counted from the pause's first asking, by its own calendar for `assignees`.
 */
export async function limitsOffered(
  parts: CalendarParts,
  pause: PauseRecord,
  to: PauseTarget,
  assignees: readonly string[] | undefined,
): Promise<PauseLimitsOffer> {
  const span = to.escalationLimits?.maxTotalTimeout;
  const counts = countsOffered(to);
  if (span === undefined) return counts;
  const { add } = calendarOfTarget(parts, pause, to, assignees);
  const maxExpiresAt = await instantAfter(span, copyOf(pause.firstAskedAt), add);
  return { ...counts, maxExpiresAt };
}

/** How many times the pause's deadline was changed: the `timeout-changed` entries of its chain. */
export const timeoutChangesOf = (pause: Pick<PauseRecord, "trail">): number =>
  pause.trail.filter((entry) => entry.action === "timeout-changed").length;

/** `PauseError.EscalationLimitExceeded`, naming the pause by its key and the limit by its name. */
export const limitExceeded = (
  pause: PauseRecord,
  limit: string,
): PauseError.EscalationLimitExceeded =>
  new PauseError.EscalationLimitExceeded({
    message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: its ${limit} limit is reached`,
  });
