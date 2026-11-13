/** What a pause store of contract v2 is written with (#935): its notices, its deadlines and why a pause closed. */
export { closedAtOf, pauseClosedReasonOf } from "../infrastructure/pause-closing.js";
export { PauseExpiryBound } from "../infrastructure/pause-record.js";
export {
  NO_RECIPIENTS,
  PauseNoticeKind,
  recipientKeysOf,
  type PauseExtension,
  type PauseFilter,
  type PauseMailbox,
  type PauseNotice,
  type PauseNoticeClaim,
  type PauseNoticeCounts,
  type PauseNoticeFacts,
  type PausePage,
  type PauseRecipients,
  type SetAsideMailbox,
} from "../infrastructure/pause-notices.js";
export type { PauseExpiry, PauseUntakenResolution } from "../infrastructure/pause-record.js";
