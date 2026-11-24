import { CostReport } from "../finops/usage.js";
import { compensationRecordsOf } from "../flow/compensation.js";
import { withChildPauses } from "../flow/runtime/child-records.js";
import { StatusTrigger, ThreadStatus } from "../turns/index.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { traceUrlFieldOf } from "../tracing/trace-url.js";
import type { AppDeps } from "./app-deps.js";
import { checkpointOf } from "./cancelled-output.js";
import { reasonOfError } from "./interrupt-requests.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";
import { ExecutionStatus, type PausedExecutionOutput } from "./types.js";

/**
 * A tree parked by an operator's `app.pause` (#1341c): its pass met the pause, nothing was undone and
 * no record ended — its call resolves `ExecutionStatus.Paused` with `isExternallyPaused`, its root's
 * record goes `running` → `paused` (what no recovery continues) and its checkpoint is what
 * `app.unpause` continues from. `pending` lists the business pauses of the tree, none for a tree
 * parked at a step boundary.
 */

/** The paused output of the tree `state` was parked at: built from its last checkpoint. */
export async function parkedOutputOf(
  deps: AppDeps,
  state: TreeState,
  cause: Error,
): Promise<PausedExecutionOutput> {
  const values = await checkpointOf(deps, state);
  const reason = reasonOfError(cause);
  return {
    status: ExecutionStatus.Paused,
    isExternallyPaused: true,
    ...(reason === undefined ? {} : { reason }),
    threadId: state.threadId,
    tenantId: state.tenantId,
    executionId: state.runId,
    path: values.path,
    spend: CostReport.fromUsage(values.usage),
    launches: values.launches,
    children: withChildPauses(values.children, []),
    handledErrors: values.handledErrors,
    compensations: compensationRecordsOf(values.compensations),
    toolCalls: values.toolCalls,
    pending: [],
    ...traceUrlFieldOf(deps.tracing, {
      workflow: deps.config.name,
      threadId: state.threadId,
      tenantId: state.tenantId,
      runId: state.runId,
    }),
  };
}

/**
 * The root's record at the park, under the tree's lease: `running` → `paused` (a compare-and-set: a
 * record a cancel or a stop ended meanwhile is left alone), its thread's status `ExternallyPaused`
 * — `DualPaused` when a business pause is open too (the record was `paused` already: the row is
 * written by the same compare-and-set from `paused`). The operator's reason rides on the row.
 */
export async function parkedRecord(
  parts: Pick<TreeMoveParts, "deps">,
  state: TreeState,
  result: PausedExecutionOutput,
  lease: Pick<HeldExecutionLease, "token">,
): Promise<void> {
  const { turns } = parts.deps;
  const record = await turns.findByTenantIdAndRunId(state.tenantId, state.runId);
  if (record === undefined || record.threadId !== state.threadId) return;
  const isDual = result.pending.length > 0;
  const context = {
    toStatus: isDual ? ThreadStatus.DualPaused : ThreadStatus.ExternallyPaused,
    trigger: StatusTrigger.Pause,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(lease.token === undefined ? {} : { leaseToken: lease.token }),
  };
  await turns.completeIfStatus(
    record.id,
    isDual ? ExecutionRecordStatus.Paused : ExecutionRecordStatus.Running,
    { ...record, status: ExecutionRecordStatus.Paused },
    context,
  );
}


/**
 * A pass that returned paused, looked at once more under the tree's lease: parked by an operator's
 * pause (its output says so), or resting at a business pause while the lease row carries the freeze.
 * Either is recorded as such and returned — the drain stops there: no answer is taken, no deadline
 * expired. `undefined` for a rest nobody froze.
 */
export async function parkedAtRest(
  parts: Pick<TreeMoveParts, "deps" | "leases">,
  state: TreeState,
  result: PausedExecutionOutput,
  lease: Pick<HeldExecutionLease, "token">,
): Promise<PausedExecutionOutput | undefined> {
  const { pause } = await parts.leases.pauseOf({
    tenantId: state.tenantId,
    rootExecutionId: state.runId,
  });
  if (!result.isExternallyPaused && pause === undefined) return undefined;
  const reason = result.reason ?? pause?.reason;
  const parked = { ...result, isExternallyPaused: true, ...(reason === undefined ? {} : { reason }) };
  await parkedRecord(parts, state, parked, lease);
  return parked;
}
