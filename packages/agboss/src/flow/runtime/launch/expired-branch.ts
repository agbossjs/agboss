import { copyOf } from "../../../infrastructure/instants.js";
import { StepError } from "../../../core/error-families/step-errors.js";
import { errorRecordOf, type ErrorRecord } from "../../../core/error-record.js";
import { effectiveBoundOf } from "../../../infrastructure/pause-bound.js";
import {
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../../infrastructure/pause-record.js";
import { isRunBound, PauseExpirySignal } from "../pause-expiry-failure.js";
import { ComponentKind } from "../records.js";
import { branchKeyOf } from "../pause.js";
import type { LaunchPauses } from "./withdrawn-pauses.js";
import type { BranchTicket } from "./records.js";

/**
 * A branch whose pause expired (#945): `BranchStatus.Expired`. Two ways to find it: the step threw
 * `StepError.PauseExpired` (the pause ran to its end in this pass), or the branch never ran again because
 * its launch was already aborted — a quorum whose deadline bound its pause is decided by then — and
 * its pause is read from the store: closed `Expired` with no answer.
 */

/** Whether `error` is, or was caused by, an expired pause of a branch's own step or a quorum's. */
export function isExpiredPause(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof StepError.PauseExpired) return true;
    if (current instanceof PauseExpirySignal)
      return effectiveBoundOf(current.pause) === PauseExpiryBound.Quorum;
  }
  return false;
}

/** The expiry as the failure of the step that asked, from the pause's record. */
function expiryOf(pause: PauseRecord): StepError.PauseExpired {
  const isAgent = pause.component?.kind !== ComponentKind.ExternalTask;
  return new StepError.PauseExpired({
    step: pause.step,
    stepKind: isAgent ? ComponentKind.Agent : ComponentKind.ExternalTask,
    target: pause.target,
    channel: pause.channel,
    pauseKind: pause.kind,
    expiresAt: copyOf(pause.expiresAt ?? pause.askedAt),
    usage: [],
  });
}

/**
 * The record of an expired pause under `branch` that no step saw, `undefined` when there is none:
 * closed `Expired` (no answer), not bound by the run's deadline (its deadline has the final word).
 */
export async function expiredErrorOf(
  site: LaunchPauses,
  branch: BranchTicket,
  runDeadlineAt: string | undefined,
): Promise<ErrorRecord | undefined> {
  const key = branchKeyOf({ ...branch, executionId: site.launchExecutionId });
  const { stores, tenantId, rootExecutionId } = site;
  const records = await stores.pauses.findAllByTenantIdAndRootExecutionId(
    tenantId,
    rootExecutionId,
  );
  const expired = records.find(
    (pause) =>
      pause.status === PauseStatus.Cancelled &&
      pause.resolution === PauseResolution.Expired &&
      !isRunBound(pause, runDeadlineAt) &&
      (pause.branchKeys ?? [branchKeyOf(pause)]).includes(key),
  );
  return expired === undefined ? undefined : errorRecordOf(expiryOf(expired));
}
