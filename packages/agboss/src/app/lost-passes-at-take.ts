import {
  LOST_PASSES_KEY,
  lostPassesOf,
  type LostPasses,
} from "../flow/runtime/lost-pass-records.js";
import type { AuditLogReader } from "./app-deps-parts.js";
import type { RootCheckpoints } from "./execution-leases.js";
import type { UnknownCostTally } from "../core/observer-manager.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { TreeCall } from "./live-runs.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";

/**
 * What a pass that takes a tree over reads to find the passes its previous holders lost (#853): the
 * tree's head checkpoint (with its tasks' writes) and its audit log. Read on the recovery path only
 * — a recovery, a resume — never on a tree's first pass.
 */
export interface LostPassSources {
  readonly checkpoints?: RootCheckpoints | undefined;
  readonly auditLog?: AuditLogReader | undefined;
  readonly log: FrameworkLog;
  /** The instance's tally of Unknown-cost entries (#875): a failed read is counted there. */
  readonly tally?: UnknownCostTally | undefined;
  /** The tree's workflow: the tally's label. */
  readonly workflow: string;
}

/** LangGraph's channels of a task's writes that run it again: an interrupt, its resume, an error. */
const RERUN_CHANNELS: ReadonlySet<string> = new Set(["__interrupt__", "__resume__", "__error__"]);

/**
 * The passes lost at the tree's head checkpoint, or `undefined` (none, or nothing to read them
 * from). A read that fails records none and says so in the log and the instance's tally (#875): the
 * pass goes on — what it runs again is billed and counted as usual, only the lost pass's Unknown
 * entry is missing.
 */
export async function lostPassesAtTake(
  sources: LostPassSources,
  state: TreeState,
): Promise<LostPasses | undefined> {
  const { checkpoints, auditLog } = sources;
  if (checkpoints === undefined || auditLog === undefined) return undefined;
  try {
    const head = await checkpoints.checkpointer.getTuple({
      configurable: { thread_id: state.runId },
    });
    if (head === undefined) return undefined;
    const rows = await auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
      state.tenantId,
      state.runId,
    );
    // a pause's or a failure's write leaves its task to run again: only another write finished it
    const settled = (head.pendingWrites ?? [])
      .filter(([, channel]) => !RERUN_CHANNELS.has(channel))
      .map(([taskId]) => taskId);
    return lostPassesOf(state.runId, head.checkpoint.id, rows, settled);
  } catch (error) {
    sources.log.warn(
      "cost.unknown-unrecorded",
      `the lost passes of execution ${state.runId} could not be read, no Unknown-cost entry is recorded for them: ${error instanceof Error ? error.message : String(error)}`,
      { executionId: state.runId, tenantId: state.tenantId },
    );
    sources.tally?.unrecorded(sources.workflow);
    return undefined;
  }
}

/** `call` carrying `lost` to the pass's tasks (its graph's `configurable`); as it is without. */
export const withLostPasses = (call: TreeCall, lost: LostPasses | undefined): TreeCall =>
  lost === undefined
    ? call
    : { ...call, configurable: { ...call.configurable, [LOST_PASSES_KEY]: lost } };

/**
 * `call` with the passes the tree's previous holders lost at its head checkpoint (#853), read once
 * the lease is held: its steps pending there record one Unknown-cost entry per lost pass.
 */
export async function callWithLostPasses(
  parts: Pick<TreeMoveParts, "deps" | "auditLog">,
  state: TreeState,
  call: TreeCall,
): Promise<TreeCall> {
  const sources = {
    checkpoints: parts.deps.pause,
    auditLog: parts.auditLog,
    log: parts.deps.log,
    tally: parts.deps.observer.unknownCosts,
    workflow: parts.deps.config.name,
  };
  return withLostPasses(call, await lostPassesAtTake(sources, state));
}
