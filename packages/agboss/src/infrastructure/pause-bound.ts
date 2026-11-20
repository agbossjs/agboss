import { PauseExpiryBound, type PauseRecord } from "./pause-record.js";
import { NEVER } from "./pause-scans.js";

/**
 * Which bound a pause's deadline has when it expires (#942): its recorded one — except a pause
 * extended to exactly the deadline it was made under (`expiresAt = boundAt`, which the store records
 * as `Pause`): a tie goes to the run (#941 D8), its deadline has the final word.
 */
export function effectiveBoundOf(
  pause: Pick<PauseRecord, "expiryBound" | "expiresAt" | "boundAt">,
): PauseExpiryBound | undefined {
  const { expiryBound, expiresAt, boundAt } = pause;
  const isTie = (expiresAt ?? "") >= (boundAt ?? NEVER);
  return expiryBound === PauseExpiryBound.Pause && isTie
    ? PauseExpiryBound.RunDeadline
    : expiryBound;
}
