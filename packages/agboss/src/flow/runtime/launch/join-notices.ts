import { PauseNoticeKind } from "../../../infrastructure/pause-notices.js";
import { PauseStatus } from "../../../infrastructure/pause-record.js";
import { noticesWritten, recipientsIn } from "../../../pause/index.js";
import { branchKeyOf } from "../pause.js";
import { BranchStatus, type BranchOutcomeRecord, type LaunchTicket } from "./records.js";
import type { LaunchPauses } from "./withdrawn-pauses.js";

/**
 * The outcome notice of a failed join (#945, Q15): each branch that had answered — it ended
 * `Finished`, its pause `Taken` — has its channel and the listeners told once that the parallel step
 * its answer belongs to did not collect all its answers (`joinFailed`). Written by the join that
 * fails, before its first handler step runs; the store writes it once per pause, so a join run
 * again after a crash, or on another instance, changes nothing. A pause its channel decided at once
 * was never sent: the store writes none for it.
 */
export async function noticeJoinFailed(
  site: LaunchPauses | undefined,
  failure: {
    readonly ticket: LaunchTicket;
    readonly records: readonly BranchOutcomeRecord[];
    readonly errorCode: string;
  },
): Promise<void> {
  if (site === undefined) return;
  const { stores, tenantId, rootExecutionId } = site;
  const answered = new Set(
    failure.records
      .filter((record) => record.status === BranchStatus.Finished)
      .flatMap((record) => {
        const branch = failure.ticket.branches[record.index];
        return branch === undefined
          ? []
          : [branchKeyOf({ ...branch, executionId: site.launchExecutionId })];
      }),
  );
  if (answered.size === 0) return;
  const pauses = await stores.pauses.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
  const facts = { launch: failure.ticket.launchId, errorCode: failure.errorCode };
  for (const pause of pauses) {
    const keys = pause.branchKeys ?? [branchKeyOf(pause)];
    if (pause.status !== PauseStatus.Taken || !keys.some((key) => answered.has(key))) continue;
    const isWritten = await stores.pauses.noticeOnceByTenantIdAndPauseId(
      tenantId,
      pause.pauseId,
      PauseNoticeKind.JoinFailed,
      facts,
      site.now(),
      recipientsIn(stores, pause),
    );
    // looked for at once, before anything that may throw
    if (isWritten) noticesWritten(stores);
  }
}
