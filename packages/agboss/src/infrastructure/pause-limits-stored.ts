/**
 * The limits a pause carries and how a move to another target narrows them (#1307, Q-D): each is the
 * smaller of what the record holds and what the destination offers — never larger, so a laxer target
 * (or a deploy that loosened one) frees nothing a pause was bound by. Pure: the store applies it in
 * the transaction of the move.
 */

/** The counted escalation limits a pause carries (#1307): the stored part of its targets' `escalationLimits`. */
export interface PauseEscalationCounts {
  /** The most `timeout-changed` entries the pause's chain of custody may hold; absent: no limit. */
  readonly maxExtensions?: number;
  /** The most `reassigned` entries the pause's chain of custody may hold; absent: no limit. */
  readonly maxReassignments?: number;
}

/** What a destination target offers: its counts and its total-wait instant, counted from the first asking. */
export interface PauseLimitsOffer {
  /** The latest instant the destination lets a pause wait until (ISO 8601); absent: none. */
  readonly maxExpiresAt?: string | undefined;
  /** The destination's counts; absent: none. */
  readonly escalationLimits?: PauseEscalationCounts | undefined;
}

/** The limits a record carries: its `maxExpiresAt` and `escalationLimits`. */
export interface PauseLimits {
  /** The latest instant the pause may wait until (ISO 8601); absent: no limit on the total wait. */
  readonly maxExpiresAt?: string | undefined;
  /** The counts its chain of custody may hold. */
  readonly escalationLimits: PauseEscalationCounts;
}

const defined = <T>(values: readonly (T | undefined)[]): T[] =>
  values.filter((value): value is T => value !== undefined);

/** The smaller count of those given; `undefined`: none was given. */
const smallestCount = (...counts: readonly (number | undefined)[]): number | undefined => {
  const given = defined(counts);
  return given.length === 0 ? undefined : Math.min(...given);
};

/** The earlier of the ISO 8601 instants given (`toISOString()` texts sort as instants); `undefined`: none was given. */
const earliestInstant = (...instants: readonly (string | undefined)[]): string | undefined =>
  defined(instants).sort()[0];

/** The limits of `pause` after taking `offer` (none: unchanged): each field the smaller of the two. */
export function narrowedLimits(pause: PauseLimits, offer?: PauseLimitsOffer): PauseLimits {
  const held = pause.escalationLimits;
  const offered = offer?.escalationLimits;
  const maxExtensions = smallestCount(held.maxExtensions, offered?.maxExtensions);
  const maxReassignments = smallestCount(held.maxReassignments, offered?.maxReassignments);
  const maxExpiresAt = earliestInstant(pause.maxExpiresAt, offer?.maxExpiresAt);
  return {
    ...(maxExpiresAt === undefined ? {} : { maxExpiresAt }),
    escalationLimits: {
      ...(maxExtensions === undefined ? {} : { maxExtensions }),
      ...(maxReassignments === undefined ? {} : { maxReassignments }),
    },
  };
}
