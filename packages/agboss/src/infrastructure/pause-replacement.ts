import { PauseResolution, PauseStatus, type PauseRecord } from "./pause-record.js";

/**
 * A reassigned pause and its replacement (#946): the records a reassignment makes and the step key a
 * replacement is stored under — the unique `(tenant, root, step key)` key of the tree holds.
 */

/** The suffix of a replacement's step key: `~r<n>` (#946). */
const REPLACEMENT_SUFFIX = /~r\d+$/u;

/** What a step key is read from: the key, and whether the pause is a replacement. */
export interface ReplacementKeyed {
  readonly stepKey: string;
  readonly reassignedFrom?: string | undefined;
}

/**
 * The step key a pause had before any reassignment: `run-1:s:1~r2` → `run-1:s:1` — only for a
 * **replacement** (`reassignedFrom` set). An ordinary pause's key is never cut: a tool call id the
 * model chose may end in `~r1`, and it would otherwise be read as another step's chain (#946).
 */
export const originalStepKeyOf = (pause: ReplacementKeyed): string =>
  pause.reassignedFrom === undefined
    ? pause.stepKey
    : pause.stepKey.replace(REPLACEMENT_SUFFIX, "");

/**
 * The step key of the next replacement of `pause`: its original key and `~r<n>`, `n` the lowest
 * number no pause of the tree has taken (a second reassignment is `~r2`, never `~r1~r1`, #946).
 */
export function replacementStepKeyOf(pause: ReplacementKeyed, taken: ReadonlySet<string>): string {
  const original = originalStepKeyOf(pause);
  let number = 1;
  while (taken.has(`${original}~r${String(number)}`)) number += 1;
  return `${original}~r${String(number)}`;
}

/** The pause moved to a replacement: `Cancelled`, `Reassigned`, pointing at it (#946). */
export const reassignedPause = (
  pause: PauseRecord,
  replacementId: string,
  at: Date,
): PauseRecord => ({
  ...pause,
  status: PauseStatus.Cancelled,
  resolution: PauseResolution.Reassigned,
  resolvedAt: at.toISOString(),
  reassignedTo: replacementId,
});

/**
 * The pause that takes the place of `pause` for another addressee (#946): `Pending` and unsent, its
 * channel asked again; the deadline, its source, its reminder, the branches and the question are the
 * old pause's — a reassignment is no new deadline.
 */
export function replacementPause(
  pause: PauseRecord,
  replacement: { readonly pauseId: string; readonly assignee: string; readonly stepKey: string },
  at: Date,
): PauseRecord {
  return {
    ...pause,
    ...replacement,
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: at.toISOString(),
    reassignedFrom: pause.pauseId,
  };
}
