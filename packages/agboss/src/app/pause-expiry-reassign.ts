import type { ReassignExpiration } from "../channels/pause-expiration.js";
import {
  newPauseId,
  PauseExpiryBound,
  type PauseExpiry,
  type PauseRecord,
} from "../infrastructure/pause-record.js";
import { reassignedPause } from "../infrastructure/pause-replacement.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";
import { pauseTallyOf } from "../pause/pause-tally.js";
import { ownDepsOf } from "./own-deps.js";
import { assigneesOf, MAX_REASON } from "./reassign-request.js";
import type { TreeMoveParts } from "./tree-move-types.js";

/** What an expiry came to: a decision to record, or a reassignment to apply (#1310a). */
export type ExpiryOutcome = PauseExpiry | { readonly reassign: ReassignExpiration };

/** Whether a reassignment's timeout and reason are what `app.reassignPause` and a deadline accept. */
const isAskedValid = (asked: ReassignExpiration): boolean => {
  const { timeout, reason } = asked;
  const isTimeoutOk = timeout === undefined || (typeof timeout === "number" && timeout >= 1000);
  const isReasonOk =
    reason === undefined ||
    (typeof reason === "string" && reason.trim() !== "" && reason.length <= MAX_REASON);
  return isTimeoutOk && isReasonOk;
};

/** The reassignment a handler asked for, checked like `app.reassignPause`'s request; `undefined`: it is not valid. */
export function reassignmentOf(asked: ReassignExpiration): ExpiryOutcome | undefined {
  try {
    assigneesOf(asked.assignees);
  } catch {
    return undefined;
  }
  return isAskedValid(asked) ? { reassign: asked } : undefined;
}

/**
 * The replacement's deadline: `timeout` after `now`, else the channel's own wait, never past the
 * pause's `boundAt` (then the run's bound); `undefined` when the deadline given has passed already.
 */
function deadlineOf(
  pause: PauseRecord,
  wait: unknown,
  now: Date,
): { readonly expiresAt?: string; readonly expiryBound?: PauseExpiryBound } | undefined {
  const own = typeof wait === "number" ? new Date(now.getTime() + wait).toISOString() : undefined;
  const isBounded = pause.boundAt !== undefined && (own === undefined || pause.boundAt < own);
  const expiresAt = isBounded ? pause.boundAt : own;
  if (expiresAt === undefined) return {};
  if (expiresAt <= now.toISOString()) return undefined;
  return {
    expiresAt,
    expiryBound: isBounded ? PauseExpiryBound.RunDeadline : PauseExpiryBound.Pause,
  };
}

/** The reason as the chain of custody keeps it: masked by the pause's own workflow's PII policy. */
async function maskedReason(
  mask: { value(value: unknown): Promise<unknown> } | undefined,
  reason: string | undefined,
): Promise<string | undefined> {
  return reason === undefined || mask === undefined
    ? reason
    : ((await mask.value(reason)) as string);
}

/** Applies what an expiry came to when it is a reassignment; `failed` for any other outcome. */
export async function movedOnExpiry(
  parts: TreeMoveParts,
  pause: PauseRecord,
  outcome: ExpiryOutcome,
): Promise<"done" | "lost" | "failed"> {
  return "reassign" in outcome ? reassignedOnExpiry(parts, pause, outcome.reassign) : "failed";
}

/**
 * An expiry's reassignment (#1310a): the pause's replacement made by the store's due-at
 * compare-and-set — the old pause closed `reassigned`, the new one `Pending` and unsent under a new
 * deadline, its channel asked by the re-send look, the tree resting again. `lost`: another instance
 * decided first; `failed`: no deadline can be given, so the pause expires as `fail()`.
 */
export async function reassignedOnExpiry(
  parts: TreeMoveParts,
  pause: PauseRecord,
  asked: ReassignExpiration,
): Promise<"done" | "lost" | "failed"> {
  const stores = parts.deps.pause;
  if (stores === undefined) return "failed";
  const own = ownDepsOf(parts.deps, pause.workflow);
  const now = parts.clock.now();
  const due = deadlineOf(pause, asked.timeout ?? own.channelOf?.(pause.channel).expiresIn, now);
  if (due === undefined) return "failed";
  const reason = await maskedReason(own.pii?.observability, asked.reason);
  const replacement = await stores.pauses.reassignByTenantIdAndPauseId(
    pause.tenantId,
    pause.pauseId,
    {
      pauseId: newPauseId(),
      assignees: asked.assignees,
      ...(reason === undefined ? {} : { reason }),
      due,
    },
    now,
    recipientsIn(stores, pause),
  );
  if (replacement === undefined) return "lost";
  noticesWritten(stores);
  pauseTallyOf(stores)?.closed(reassignedPause(pause, replacement.pauseId, now));
  pauseTallyOf(stores)?.reassigned(replacement);
  return "done";
}
