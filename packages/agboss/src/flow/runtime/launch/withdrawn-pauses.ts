import {
  cancelledPause,
  logPauseAnswer,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../../infrastructure/pause-record.js";
import type { PauseSeam } from "../../../pause/index.js";
import { PauseWithdrawnError } from "../pause.js";
import type { BranchTicket, LaunchTicket } from "./records.js";

/**
 * A `FailFast` failure cancels its launch (#273 S21) — paused siblings too (#267 AC10): their
 * pending pauses are withdrawn (`Cancelled`, `PauseResolution.Withdrawn`), so the tree goes on to the join instead of waiting
 * for answers nobody needs, and a late answer gets `NotPausedError`. A withdrawn branch ends
 * `Cancelled` when it runs again.
 */

/** Where a launch runs: its tree (tenant and root) and its launch ticket. */
export interface WithdrawalSite {
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly launch: LaunchTicket;
  /** The branch that failed: its own pauses are not its siblings'. */
  readonly failed: BranchTicket;
  /** When (the application's clock): the pauses' `resolvedAt`. */
  readonly at: Date;
}

/** Whether a pause waits in one of the launch's other branches. */
const isSiblingOf = (site: WithdrawalSite, pause: PauseRecord): boolean =>
  site.launch.branches.some(
    (branch) =>
      branch.index !== site.failed.index &&
      branch.nodeId === pause.nodeId &&
      branch.visitNumber === pause.visitNumber &&
      branch.itemIndex === pause.itemIndex,
  );

/** Withdraws every pending pause of the failed branch's siblings. */
export async function withdrawSiblingPauses(
  stores: Pick<PauseSeam, "pauses" | "answers">,
  site: WithdrawalSite,
): Promise<void> {
  const { tenantId, rootExecutionId, at } = site;
  const { pauses, answers } = stores;
  const records = await pauses.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
  const withdrawn = PauseResolution.Withdrawn;
  for (const pause of records) {
    if (
      pause.status === PauseStatus.Pending &&
      isSiblingOf(site, pause) &&
      (await pauses.cancelByTenantIdAndPauseId(tenantId, pause.pauseId, withdrawn, at))
    )
      await logPauseAnswer(answers, cancelledPause(pause, withdrawn, at), withdrawn);
  }
}

/** Whether a branch stopped because its pause was withdrawn (also through a cause). */
export function isWithdrawn(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof PauseWithdrawnError) return true;
  }
  return false;
}
