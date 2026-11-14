import { ExecutionCancelledError } from "../core/errors.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
  type PauseUntakenResolution,
} from "../infrastructure/paused-execution.repository.js";
import { logPauseNotTaken } from "../infrastructure/pause-answer-log.js";
import { withdrawPause, type PauseStores } from "../flow/runtime/launch/withdrawn-pauses.js";
import type { Turn } from "../turns/index.js";
import { CANCELLED_STOP_REASON, cancelledErrorOf } from "./live-runs.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";

/**
 * A tree's end closes its pauses (#939, #910 I13). The tree's own paused run goes first (only that
 * run's, never a later run of the thread, #807), then every pause: a waiting one closes (the store
 * may record `Expired`), an answer no step consumed (`Resolved`) is closed *not taken*, one a step
 * consumed is already `Taken` and left alone (a step marks it the moment it takes it, before it
 * acts, #939). Every step is idempotent: a death in between is finished by the next call, the
 * orphan look's among them.
 */

/** The tree whose end closes: where its paused run is kept, and its root. */
export interface TreeEndSite {
  readonly tenantId: string;
  readonly threadId: string;
  readonly rootExecutionId: string;
}

/** How the tree ended. */
export interface PauseEnd {
  readonly cause: Error;
}

/** What closing a tree's pauses needs: the pause stores and the root's checkpoint. */
export interface TreePauseEnds {
  readonly stores: PauseStores;
}

/** Whether an error is a cancel, or was caused by one. */
function isCancel(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause)
    if (current instanceof ExecutionCancelledError) return true;
  return false;
}

/**
 * How a root's ended record says its tree ended: a cancel by the reasons the framework writes
 * itself — never free text —, else with the record's own reason.
 */
export function endOfRecord(record: Pick<Turn, "stopReason" | "threadId">): Error {
  const cancelled = [cancelledErrorOf(record.threadId).message, CANCELLED_STOP_REASON];
  return cancelled.includes(record.stopReason)
    ? cancelledErrorOf(record.threadId)
    : new Error(record.stopReason);
}

/** How a tree's end closes its pauses (Q1): `Cancelled` for a cancel, else `TreeEnded`. */
export const resolutionOfEnd = (end: PauseEnd): PauseUntakenResolution =>
  isCancel(end.cause) ? PauseResolution.Cancelled : PauseResolution.TreeEnded;

/** Closes one pause by its status now; `false` when it changed under the call (read again). */
async function closedOne(
  ends: TreePauseEnds,
  pause: PauseRecord,
  how: { readonly resolution: PauseUntakenResolution; readonly at: Date },
): Promise<boolean> {
  const { stores } = ends;
  const { tenantId, pauseId } = pause;
  if (pause.status === PauseStatus.Pending)
    return withdrawPause(stores, pause, { resolution: how.resolution, at: how.at });
  if (pause.status !== PauseStatus.Resolved) return true;
  const closed = await stores.pauses.closeUntakenByTenantIdAndPauseId(
    tenantId,
    pauseId,
    how.resolution,
    how.at,
    recipientsIn(stores, pause),
  );
  if (closed === undefined) return false;
  noticesWritten(stores);
  await logPauseNotTaken(stores.answers, closed);
  return true;
}

/** Removes the tree's paused run and closes every pause it still has. */
export async function closeTreePauses(
  ends: TreePauseEnds,
  site: TreeEndSite,
  end: PauseEnd,
  at: Date,
): Promise<void> {
  const { stores } = ends;
  const { tenantId, threadId, rootExecutionId } = site;
  await stores.pauses.deleteByTenantIdAndThreadIdAndRunId(tenantId, threadId, rootExecutionId);
  const how = { resolution: resolutionOfEnd(end), at };
  for (const pause of await stores.pauses.findAllByTenantIdAndRootExecutionId(
    tenantId,
    rootExecutionId,
  )) {
    // a pause that changed meanwhile (an answer recorded, a sibling's close) is read again, once
    if (await closedOne(ends, pause, how)) continue;
    const now = await stores.pauses.findByTenantIdAndPauseId(tenantId, pause.pauseId);
    if (now !== undefined) await closedOne(ends, now, how);
  }
}
