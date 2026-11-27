/** What a pause store of contract v2 is written with (#935): its notices, its deadlines and why a pause closed. */
export { closedAtOf, pauseClosedReasonOf } from "../infrastructure/pause-closing.js";
export { PauseExpiryBound } from "../infrastructure/pause-record.js";
export {
  narrowedLimits,
  type PauseEscalationCounts,
  type PauseLimits,
  type PauseLimitsOffer,
} from "../infrastructure/pause-limits-stored.js";
export {
  originalStepKeyOf,
  replacementStepKeyOf,
  type ReplacementKeyed,
} from "../infrastructure/pause-replacement.js";
export { isAsSeen, isSeenAs, seenOf } from "../infrastructure/pause-seen.js";
/**
 * The pure transitions of a pause every store applies atomically (#1307, P6b): what changes the
 * record and which notices it writes, or `undefined` when the condition does not hold. A store calls
 * these over the record it read (a row lock, a transaction, a conditional write) and writes the result;
 * it never restates the rules. Times are `Date`s, compared by instant; an Invalid Date given to one of
 * them (`at`, a deadline it sets, a time of a notice) is a `StoreError.UnreadableRecord`, never "the
 * condition does not hold". `PauseTransition` is the plan a rule makes (what the record becomes and the
 * notices it writes); the `*Change` names are the rules, `PauseTimeoutChange` the input of `timeoutChange`.
 * `onceNotices` is the rule of `noticeOnceByTenantIdAndPauseId`: the notices of one kind a sent pause owes.
 */
export {
  cancelChange,
  closeUntakenChange,
  decideChange,
  expireChange,
  isDueAt,
  isOpenAt,
  markSentChange,
  onceNotices,
  remindChange,
  resolveChange,
  type PauseTransition,
} from "../infrastructure/pause-transitions.js";
export { timeoutChange } from "../infrastructure/pause-timeout-change.js";
export { reassignChange } from "../infrastructure/pause-reassign-transition.js";
export { reassignedPause } from "../infrastructure/pause-replacement.js";
export { inFirstSendNotices, openingNotices } from "../infrastructure/pause-notice-plans.js";
export { isWithinCap } from "../infrastructure/pause-limits-stored.js";
export type { PlannedNotice } from "../infrastructure/pause-mailboxes.js";
/**
 * Moments of a pause (#1307, G3): compare two `Date`s with these, never with `===` (a reference
 * compare); read a time a store kept as text with `instantOfText`, which accepts only what
 * `toISOString()` writes and throws `StoreError.UnreadableRecord` for anything else.
 */
export {
  assertValidInstant,
  instantOfText,
  isAtOrBefore,
  isBefore,
  sameInstant,
} from "../infrastructure/instants.js";
/** Every time of a pause a store is about to keep: an Invalid Date is refused (`StoreError.UnreadableRecord`) before the write. */
export { assertPauseInstants } from "../infrastructure/pause-instants-valid.js";
export {
  NO_RECIPIENTS,
  PauseNoticeKind,
  recipientKeysOf,
  type PauseTimeoutChange,
  type PauseFilter,
  type PauseMailbox,
  type PauseNotice,
  type PauseNoticeClaim,
  type PauseNoticeCounts,
  type PauseNoticeFacts,
  type PausePage,
  type PauseRecipients,
  type PauseReplacement,
  type PauseScanAfter,
  type SetAsideMailbox,
} from "../infrastructure/pause-notices.js";
export type {
  PauseExpiry,
  PauseFirstClose,
  PauseUntakenResolution,
} from "../infrastructure/pause-record.js";
