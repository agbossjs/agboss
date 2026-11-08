import { LOST_PASSES_KEY, lostPassesOf, type LostPasses } from "../finops/lost-passes.js";
import type { LeaseEventsReader } from "./app-deps-parts.js";
import type { RootCheckpoints } from "./execution-leases.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { TreeCall } from "./live-runs.js";
import type { TreeState } from "./tree-move-types.js";

/**
 * What a pass that takes a tree over reads to find the passes its previous holders lost (#853): the
 * tree's head checkpoint (with its tasks' writes) and its lease log. Read on the recovery path only
 * — a recovery, a resume — never on a tree's first pass.
 */
export interface LostPassSources {
  readonly checkpoints?: RootCheckpoints | undefined;
  readonly leaseEvents?: LeaseEventsReader | undefined;
  readonly log: FrameworkLog;
}

/**
 * The passes lost at the tree's head checkpoint, or `undefined` (none, or nothing to read them
 * from). A read that fails records none and says so in the log: the pass goes on — what it runs
 * again is billed and counted as usual, only the lost pass's Unknown entry is missing.
 */
export async function lostPassesAtTake(
  sources: LostPassSources,
  state: TreeState,
): Promise<LostPasses | undefined> {
  const { checkpoints, leaseEvents } = sources;
  if (checkpoints === undefined || leaseEvents === undefined) return undefined;
  try {
    const head = await checkpoints.checkpointer.getTuple({
      configurable: { thread_id: state.runId },
    });
    if (head === undefined) return undefined;
    const rows = await leaseEvents.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
      state.tenantId,
      state.runId,
    );
    const settled = (head.pendingWrites ?? []).map(([taskId]) => taskId);
    return lostPassesOf(state.runId, head.checkpoint.id, rows, settled);
  } catch (error) {
    sources.log.warn(
      "cost.unknown-unrecorded",
      `the lost passes of execution ${state.runId} could not be read, no Unknown-cost entry is recorded for them: ${error instanceof Error ? error.message : String(error)}`,
      { executionId: state.runId, tenantId: state.tenantId },
    );
    return undefined;
  }
}

/** `call` carrying `lost` to the pass's tasks (its graph's `configurable`); as it is without. */
export const withLostPasses = (call: TreeCall, lost: LostPasses | undefined): TreeCall =>
  lost === undefined
    ? call
    : { ...call, configurable: { ...call.configurable, [LOST_PASSES_KEY]: lost } };
