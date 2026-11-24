import type { PauseReplacement } from "./pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
  type PauseTrailRecord,
} from "./pause-record.js";

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

/** The entry a reassignment adds to the chain of custody: who moved the pause, when, to whom, why. */
function reassignedEntryOf(
  pause: PauseRecord,
  replacement: ReplacementOf,
  at: Date,
): PauseTrailRecord {
  const { assignees, actor, reason, due } = replacement;
  const expiresAt = due === undefined ? pause.expiresAt : due.expiresAt;
  return {
    action: "reassigned",
    at: at.toISOString(),
    ...(actor === undefined ? {} : { actor }),
    target: pause.channel,
    channel: pause.channel,
    assignees,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** What a replacement is made from. */
type ReplacementOf = Pick<
  PauseReplacement,
  "pauseId" | "assignees" | "actor" | "reason" | "due"
> & {
  readonly stepKey: string;
};

/** The old pause without what a replacement does not keep: its reference, and on an expiry its deadline and reminder. */
function keptOf(pause: PauseRecord, isExpiry: boolean): Omit<PauseRecord, "externalRef"> {
  const dropped: readonly string[] = isExpiry
    ? ["externalRef", "expiresAt", "expiryBound", "remindAt"]
    : ["externalRef"];
  return Object.fromEntries(
    Object.entries(pause).filter(([key]) => !dropped.includes(key)),
  ) as Omit<PauseRecord, "externalRef">;
}

/**
 * The pause that takes the place of `pause` for other addressees (#946): `Pending` and unsent, its
 * channel asked again; the deadline, its source, its reminder, the branches and the question are the
 * old pause's — a reassignment is no new deadline, unless an expiry made it (`due`, #1310a). Its
 * chain of custody is the old one's and a `reassigned` entry; the channel's reference is not kept.
 */
export function replacementPause(
  pause: PauseRecord,
  replacement: ReplacementOf,
  at: Date,
): PauseRecord {
  const { pauseId, assignees, stepKey, due } = replacement;
  return {
    ...keptOf(pause, due !== undefined),
    ...due,
    pauseId,
    assignees,
    stepKey,
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: at.toISOString(),
    reassignedFrom: pause.pauseId,
    trail: [...pause.trail, reassignedEntryOf(pause, replacement, at)],
  };
}
