import { CompensationFailedError } from "../flow/compensation.js";
import type { Turn } from "../turns/index.js";
import type { AppDeps } from "./app-deps.js";
import { endHeld, writeCancelRequest, type CancelParts } from "./cancel-requests.js";
import type { CancelCommand } from "./cancel-paused.js";
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

/** What became of a requested tree: ended by this call, left to its holder, or nothing to end. */
export enum InterruptSettlement {
  Ended = "ended",
  Requested = "requested",
  None = "none",
}

/**
 * What became of a requested tree after the request: one this call ended (`Ended`) whose undo
 * failed rejects with `CompensationFailedError` (#340 S7 1); a `running` one is its holder's
 * (`Requested`).
 */
async function settled(parts: CancelParts, record: Turn): Promise<InterruptSettlement> {
  if (record.runId === null) return InterruptSettlement.None;
  const state = stateOf(parts.deps, record, record.runId);
  if (record.status === "running") return InterruptSettlement.Requested;
  if (record.status === "paused") {
    const ended = await endHeld(parts, state);
    if (ended instanceof CompensationFailedError) throw ended;
    return ended === undefined ? InterruptSettlement.None : InterruptSettlement.Ended;
  }
  // it ended between the request and now: the request is withdrawn with the tree's keys
  await parts.trees.deleteAllInTree(treeOf(state));
  return InterruptSettlement.None;
}

/**
 * A cancel or stop of a thread whose execution runs on another instance (#360, #1341b): every
 * `running` root of the thread gets a request, then is read again — still running: `Requested`
 * (its holder stops within one renewal, or recovery ends it); paused meanwhile: ended here; ended:
 * `None`. A root whose `running` record is not written yet (its budgets, its thread's compaction)
 * is not found: `None` (S1 5). The strongest settlement of the thread's roots.
 */
export async function remoteInterrupt(
  parts: CancelParts,
  thread: ThreadKey,
  command: CancelCommand = {},
): Promise<InterruptSettlement> {
  const { deps, clock } = parts;
  const records = await deps.turns.lastTurns(thread.tenantId, thread.threadId, RECORDS);
  // a root parked by an operator's `app.pause` (#1341c) rests `paused` with no paused run: ended here too
  const running = records.filter(
    (record) =>
      (record.status === "running" || record.status === "paused") &&
      record.workflow === deps.config.name,
  );
  const request = {
    requestedAt: clock.now().toISOString(),
    ownerId: command.ownerId ?? null,
    reason: command.reason,
    threadId: thread.threadId,
    ...(command.kind === undefined ? {} : { kind: command.kind, mode: command.mode }),
  };
  for (const { runId } of running)
    if (runId !== null)
      await writeCancelRequest(
        parts,
        { tenantId: thread.tenantId, rootExecutionId: runId },
        request,
      );
  const now = running.length === 0 ? [] : await deps.turns.byIds(running.map(({ id }) => id));
  const settlements: InterruptSettlement[] = [];
  for (const record of now) settlements.push(await settled(parts, record));
  return (
    [InterruptSettlement.Ended, InterruptSettlement.Requested].find((each) =>
      settlements.includes(each),
    ) ?? InterruptSettlement.None
  );
}

/** `remoteInterrupt` of a cancel: `true` when the thread counts as cancelled. */
export async function remoteCancel(
  parts: CancelParts,
  thread: ThreadKey,
  ownerId: string | undefined,
  reason?: string,
): Promise<boolean> {
  return (await remoteInterrupt(parts, thread, { ownerId, reason })) !== InterruptSettlement.None;
}
