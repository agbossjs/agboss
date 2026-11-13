import type { PauseNotice, PauseNoticeClaim } from "../../infrastructure/pause-notices.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import { seconds } from "../../units/index.js";
import { ALL_KEYS } from "./paused-execution-data.js";

/**
 * Reading a mailbox through the contract alone: a claim shows its notices. Each peek is made later
 * than the one before and claims for a moment only, so it never holds the mailbox from the next.
 */
export const FAR = Date.UTC(2027, 0, 1);

/** The peek of `store`: every due mailbox of `recipients` (default: all of them), claimed briefly. */
export function peeker(
  store: PausedExecutionRepository,
): (recipients?: readonly string[]) => Promise<readonly PauseNoticeClaim[]> {
  let step = 0;
  return (recipients = ALL_KEYS) => {
    step += seconds(1);
    return store.claimNoticesDue(new Date(FAR + step), 1000, seconds(0.5), recipients);
  };
}

/** The notices of one mailbox among `claims`, as `kind` in order; none when it is not there. */
export const kindsOf = (
  claims: readonly PauseNoticeClaim[],
  pauseId: string,
  recipient: string,
): readonly string[] => noticesOf(claims, pauseId, recipient).map((notice) => notice.kind);

/** The notices of one mailbox among `claims`. */
export const noticesOf = (
  claims: readonly PauseNoticeClaim[],
  pauseId: string,
  recipient: string,
): readonly PauseNotice[] =>
  claims.find((one) => one.mailbox.pauseId === pauseId && one.mailbox.recipient === recipient)
    ?.mailbox.notices ?? [];
