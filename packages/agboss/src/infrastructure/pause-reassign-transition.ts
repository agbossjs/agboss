import type { PauseRecipients, PauseReplacement } from "./pause-notices.js";
import type { PauseRecord } from "./pause-record.js";
import { reassignedPause, replacementPause, replacementStepKeyOf } from "./pause-replacement.js";
import { closing, isOpenAt, type PauseChange } from "./pause-transitions.js";

/**
 * `Pending → Cancelled / Reassigned` and the replacement made (#946), only while the pause is open at
 * `at`: no deadline, or one after it — a deadline at `at` is over (I2). The replacement keeps the
 * deadline and the rest of the question, takes the next free `~r<n>` of the step's key among
 * `takenStepKeys` (the step keys of the tree), is unsent: its `opened` is written when its channel was
 * asked. The old pause's `closed` goes to its receivers when it was sent, like every close's.
 */
export function reassignChange(
  pause: PauseRecord,
  replacement: PauseReplacement,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (!isOpenAt(pause, at)) return undefined;
  const stepKey = replacementStepKeyOf(pause, takenStepKeys);
  return {
    ...closing(pause, reassignedPause(pause, replacement.pauseId, at), at, recipients),
    inserted: replacementPause(pause, { ...replacement, stepKey }, at),
  };
}
