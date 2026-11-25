import { ExecutionOperation } from "../core/observability.js";
import { InvalidThreadIdError, keyTextRuleOf } from "../core/errors.js";
import { ExecutionError } from "../core/error-families/run-errors.js";
import { PauseError } from "../core/error-families/pause-errors.js";
import { checkedCallerId, checkedTenantId } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import type { CancelThreadParts } from "./cancel-thread.js";
import { maskedOperatorReason } from "./interrupt-requests.js";
import type { UnpauseExecutionOptions } from "./interrupt-types.js";
import type { TreeMoves } from "./tree-moves.js";
import { maskedRecordOf } from "./result.js";
import type { ExecutionOutput } from "./types.js";

/**
 * `app.unpause(threadId, { tenantId, ownerId, reason, signal, onStream, … })` (#1341c): lifts the
 * freeze of `app.pause` — the tree parked at a step boundary continues from its last checkpoint
 * (`onExecutionResume` with `ResumeReason.Unpaused`), one frozen at a business pause (`dual_paused`)
 * waits for its answer again, taking at once what a channel decided or what expired meanwhile. A
 * pause still parking (`Pausing`) is awaited — the lease is the one place the freeze is lifted — so
 * the call returns once the tree moved or rests. `PauseError.NotPaused` for a thread not frozen from
 * outside (running, or resting at a business pause only), `ExecutionError.AlreadyTerminal` for one
 * that ended. Another tenant's thread does not exist for the caller (#261).
 */
export async function unpauseThread(
  parts: CancelThreadParts & { readonly moves: TreeMoves },
  threadId: string,
  options: UnpauseExecutionOptions & { readonly tenantId?: string | undefined },
): Promise<ExecutionOutput> {
  const { deps, leases, moves } = parts;
  const thread = { tenantId: options.tenantId ?? DEFAULT_TENANT_ID, threadId };
  await parts.admit({ operation: ExecutionOperation.Unpause, ...thread }, () => {
    checkedTenantId(thread.tenantId);
    const rule = keyTextRuleOf(threadId);
    if (rule !== undefined) throw new InvalidThreadIdError({ rule });
    checkedCallerId("UnpauseExecutionOptions", "ownerId", options.ownerId);
    return parts.known({ ...thread, ownerId: options.ownerId });
  });
  const records = await deps.turns.lastTurns(thread.tenantId, threadId, 20);
  const own = records.filter((record) => record.workflow === deps.config.name);
  const alive = own.filter(
    (record) =>
      record.runId !== null && (record.status === "running" || record.status === "paused"),
  );
  const record = alive.at(-1);
  if (record?.runId == null) {
    if (own.length > 0)
      throw new ExecutionError.AlreadyTerminal({
        message: `thread "${threadId}" has ended: it cannot be unpaused`,
      });
    throw notPaused(threadId);
  }
  const tree = { tenantId: thread.tenantId, rootExecutionId: record.runId };
  // the database's mark first: a thread not frozen from outside is refused without waiting for a lease
  if ((await leases.pauseOf(tree)).pause === undefined) throw notPaused(threadId);
  const state = {
    runId: record.runId,
    threadId,
    tenantId: thread.tenantId,
    startedVersion: record.configVersion ?? deps.config.version,
  };
  const call = { ...options, ownerId: options.ownerId };
  const result = await moves.unpaused(state, call, {
    ownerId: options.ownerId,
    // kept in the status history: masked by the workflow's PII policy
    reason: await maskedOperatorReason(deps, options.reason),
  });
  return maskedRecordOf(result, deps);
}

const notPaused = (threadId: string): PauseError.NotPaused =>
  new PauseError.NotPaused({ message: `thread "${threadId}" is not paused from outside` });
