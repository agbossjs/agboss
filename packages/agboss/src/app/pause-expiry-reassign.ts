import type { ReassignExpiration } from "../channels/pause-expiration.js";
import { isPauseTimeout } from "../channels/channel-rules.js";
import type { PauseExpiry, PauseRecord } from "../infrastructure/pause-record.js";
import { PauseStatus } from "../infrastructure/pause-record.js";
import { reassignedPause } from "../infrastructure/pause-replacement.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";
import { pauseTallyOf } from "../pause/pause-tally.js";
import { targetOfPause } from "./answer-permit.js";
import { ownDepsOf } from "./own-deps.js";
import { planOf } from "./pause-reassign-plan.js";
import { assigneesOf, MAX_REASON } from "./reassign-request.js";
import type { TreeMoveParts } from "./tree-move-types.js";

/** What an expiry came to: a decision to record, or a reassignment to apply (#1310a). */
export type ExpiryOutcome = PauseExpiry | { readonly reassign: ReassignExpiration };

/** Whether a reassignment's timeout, reason and target are what `app.reassignPause` and a deadline accept. */
const isAskedValid = (asked: ReassignExpiration): boolean => {
  const { timeout, reason, target } = asked;
  const isTimeoutOk = timeout === undefined || isPauseTimeout(timeout);
  const isReasonOk =
    reason === undefined ||
    (typeof reason === "string" && reason.trim() !== "" && reason.length <= MAX_REASON);
  const isTargetOk = target === undefined || typeof target === "function";
  return isTimeoutOk && isReasonOk && isTargetOk;
};

/** The reassignment a target asked for, checked like `app.reassignPause`'s request; `undefined`: it is not valid. */
export function reassignmentOf(asked: ReassignExpiration): ExpiryOutcome | undefined {
  try {
    if (asked.assignees !== undefined) assigneesOf(asked.assignees, true);
  } catch {
    return undefined;
  }
  return isAskedValid(asked) ? { reassign: asked } : undefined;
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
 * An expiry's reassignment (#1310a, #1307d): made by the store's due-at compare-and-set — a pause
 * that stays with its target and channel is changed in place under a new deadline, one moved is
 * replaced (the old closed `reassigned`, the new `Pending` and unsent, its channel asked by the re-send
 * look) — the tree resting again. The target's `permitReassign` is not called: it authorizes an
 * outside `actor` (`app.reassignPause`), and an expiry has none — it is the target's own policy,
 * run by the worker's timer, and its `escalatesTo` already bounds where it may go (#1310, Q-F). `lost`: another instance decided first; `failed`: it cannot be
 * made (no deadline can be given, the target does not fit, a limit is reached), so the pause
 * expires as `fail()`.
 */
export async function reassignedOnExpiry(
  parts: TreeMoveParts,
  pause: PauseRecord,
  asked: ReassignExpiration,
): Promise<"done" | "lost" | "failed"> {
  const stores = parts.deps.pause;
  if (stores === undefined) return "failed";
  const plan = await expiryPlanOf(parts, pause, asked);
  if (plan === undefined) return "failed";
  const now = parts.clock.now();
  const changed = await stores.pauses.reassignByTenantIdAndPauseId(
    pause.tenantId,
    pause.pauseId,
    plan.change,
    now,
    recipientsIn(stores, pause),
  );
  if (changed === undefined) return refusedOnExpiry(stores, pause);
  noticesWritten(stores);
  if (!plan.isInPlace) pauseTallyOf(stores)?.closed(reassignedPause(pause, changed.pauseId, now));
  pauseTallyOf(stores)?.reassigned(changed);
  return "done";
}

/** The reassignment an expiry asked for, planned like a caller's; `undefined`: it cannot be made. */
async function expiryPlanOf(
  parts: TreeMoveParts,
  pause: PauseRecord,
  asked: ReassignExpiration,
): Promise<Awaited<ReturnType<typeof planOf>> | undefined> {
  const own = ownDepsOf(parts.deps, pause.workflow);
  const reason = await maskedReason(own.pii?.observability, asked.reason);
  try {
    return await planOf(
      { deps: parts.deps, clock: parts.clock },
      pause,
      targetOfPause(parts.deps, pause),
      {
        target: asked.target,
        assignees: asked.assignees,
        timeout: asked.timeout,
        reason,
        isExpiry: true,
      },
    );
  } catch {
    return undefined;
  }
}

/** Why the store refused an expiry's reassignment: `failed` on a limit while the pause is still pending and due, else `lost`. */
async function refusedOnExpiry(
  stores: NonNullable<TreeMoveParts["deps"]["pause"]>,
  pause: PauseRecord,
): Promise<"failed" | "lost"> {
  const fresh = await stores.pauses.findByTenantIdAndPauseId(pause.tenantId, pause.pauseId);
  // a pause marked sent meanwhile is as it was planned for in all but that: the next look moves it
  return fresh?.status === PauseStatus.Pending &&
    fresh.expiresAt === pause.expiresAt &&
    fresh.isSent === pause.isSent
    ? "failed"
    : "lost";
}
