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
