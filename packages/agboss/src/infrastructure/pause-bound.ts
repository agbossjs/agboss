import { PauseExpiryBound, type PauseRecord } from "./pause-record.js";
import { isAtOrBefore } from "./instants.js";

/**
 * Which bound a pause's deadline has when it expires (#942): its recorded one — except a pause
 * extended to exactly the deadline it was made under (`expiresAt = boundAt`, which the store records
 * as `Pause`): a tie goes to the run (#941 D8), its deadline has the final word.
 */
export function effectiveBoundOf(
  pause: Pick<PauseRecord, "expiryBound" | "expiresAt" | "boundAt">,
): PauseExpiryBound | undefined {
  const { expiryBound, expiresAt, boundAt } = pause;
  // no deadline or no bound is no tie
  const isTie =
    expiresAt !== undefined && boundAt !== undefined && isAtOrBefore(boundAt, expiresAt);
  return expiryBound === PauseExpiryBound.Pause && isTie
    ? PauseExpiryBound.RunDeadline
    : expiryBound;
}
