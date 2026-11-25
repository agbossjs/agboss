import { PauseError } from "../core/error-families/pause-errors.js";
import type { PauseTarget } from "../flow/runtime/pause-channel.js";
import type { Clock } from "../infrastructure/clock.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { pauseKeyOf, PauseStatus, type PauseRecord } from "../infrastructure/pause-record.js";
import { reassignmentsOf } from "../infrastructure/pause-reassign-transition.js";
import { targetOfPause } from "./answer-permit.js";
import type { AppDeps } from "./app-deps.js";
import { ownDepsOf } from "./own-deps.js";
import { pauseClosed } from "./pause-closed.js";
import { limitExceeded } from "./pause-limits.js";

/** What a reassignment reads and refuses with (#946, #1307d): split from `pause-reassignment.ts`. */

/** The reason as the pause's chain of custody keeps it: through the mask of the pause's own workflow. */
export async function maskedReason(
  deps: AppDeps,
  pause: PauseRecord,
  reason: string | undefined,
): Promise<string | undefined> {
  if (reason === undefined) return undefined;
  const mask = ownDepsOf(deps, pause.workflow).pii?.observability;
  return mask === undefined ? reason : ((await mask.value(reason)) as string);
}

/** The pause's own target as its workflow has it now; a deploy that removed it refuses the call. */
export function ownTargetOf(deps: AppDeps, pause: PauseRecord): PauseTarget {
  try {
    return targetOfPause(deps, pause);
  } catch (cause) {
    throw new PauseError.IncompatibleTarget({
      message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: its target is no longer in this application`,
      cause,
    });
  }
}

/** Why the store did not apply a reassignment: the pause closed, its limit was reached, or a writer won. */
export async function refusedReassignment(
  parts: { readonly pauses: PausedExecutionRepository; readonly clock: Clock },
  pause: PauseRecord,
  max: number | undefined,
): Promise<Error> {
  const now = parts.clock.now();
  const fresh =
    (await parts.pauses.findByTenantIdAndPauseId(pause.tenantId, pause.pauseId)) ?? pause;
  const isDue = fresh.expiresAt !== undefined && fresh.expiresAt <= now.toISOString();
  if (fresh.status !== PauseStatus.Pending || isDue) return pauseClosed(parts.pauses, pause, now);
  if (max !== undefined && reassignmentsOf(fresh) >= max)
    return limitExceeded(fresh, "maxReassignments");
  return new PauseError.UpdateContended({
    message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: another change won; retry is safe`,
  });
}
