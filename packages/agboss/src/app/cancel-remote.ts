import { CompensationFailedError } from "../flow/compensation.js";
import type { Turn } from "../turns/index.js";
import type { AppDeps } from "./app-deps.js";
import { endHeld, writeCancelRequest, type CancelParts } from "./cancel-requests.js";
import type { ThreadKey } from "./live-runs.js";
import { treeOf } from "./tree-ends.js";
import type { TreeState } from "./tree-move-types.js";

/** Cancelling a thread whose execution runs on another instance (#360), split from `cancel-requests.ts`. */

/** How many of a thread's last records are looked at for its root's record. */
const RECORDS = 20;

/** A record's tree as its events name it. */
const stateOf = (deps: AppDeps, record: Turn, runId: string): TreeState => ({
  runId,
  threadId: record.threadId,
  tenantId: record.tenantId,
  startedVersion: record.configVersion ?? deps.config.version,
});

/**
 * What became of a requested tree after the request: `true` when it counts as cancelled; one this
 * call ended whose undo failed rejects with `CompensationFailedError` (#340 S7 1).
 */
async function settled(parts: CancelParts, record: Turn): Promise<boolean> {
  if (record.runId === null) return false;
  const state = stateOf(parts.deps, record, record.runId);
  if (record.status === "running") return true;
  if (record.status === "paused") {
    const ended = await endHeld(parts, state);
    if (ended instanceof CompensationFailedError) throw ended;
    return ended !== undefined;
  }
  // it ended between the request and now: the request is withdrawn with the tree's keys
  await parts.trees.deleteAllInTree(treeOf(state));
  return false;
}

/**
 * A cancel of a thread whose execution runs on another instance (#360): every `running` root of
 * the thread gets a request, then is read again — still running: cancelled (its holder stops
 * within one renewal, or recovery ends it); paused meanwhile: ended here; ended: not cancelled. A
 * root whose `running` record is not written yet (its budgets, its thread's compaction) is not
 * found: `false` (S1 5).
 */
export async function remoteCancel(
  parts: CancelParts,
  thread: ThreadKey,
  ownerId: string | undefined,
  reason?: string,
): Promise<boolean> {
  const { deps, clock } = parts;
  const records = await deps.turns.lastTurns(thread.tenantId, thread.threadId, RECORDS);
  const running = records.filter(
    (record) => record.status === "running" && record.workflow === deps.config.name,
  );
  const request = { requestedAt: clock.now().toISOString(), ownerId: ownerId ?? null, reason };
  for (const { runId } of running)
    if (runId !== null)
      await writeCancelRequest(
        parts,
        { tenantId: thread.tenantId, rootExecutionId: runId },
        {
          ...request,
          threadId: thread.threadId,
        },
      );
  let isCancelled = false;
  const now = running.length === 0 ? [] : await deps.turns.byIds(running.map(({ id }) => id));
  for (const record of now) isCancelled = (await settled(parts, record)) || isCancelled;
  return isCancelled;
}
