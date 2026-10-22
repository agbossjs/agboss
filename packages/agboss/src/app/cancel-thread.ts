import { ExecutionOperation } from "../core/observability.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import type { ThreadAccess } from "../run/thread.js";
import { remoteCancel, type CancelParts } from "./cancel-requests.js";
import { cancelledOutcome, type LiveRuns } from "./live-runs.js";
import { executionEventAt, observeCancelledPause, type ExecutionRequest } from "./run-events.js";
import type { CancelOptions, CancelOutput } from "./types.js";

/** What `app.cancel` needs from its workflow's app (loaded on the first cancel). */
export interface CancelThreadParts extends CancelParts {
  readonly live: LiveRuns;
  /** Observes a refused request (`onExecutionRejected`) and rethrows it. */
  readonly admit: <T>(request: ExecutionRequest, checks: () => Promise<T>) => Promise<T>;
  /** Checks the tenant has the thread and the caller may touch it. */
  readonly known: (access: ThreadAccess) => Promise<void>;
}

/**
 * `app.cancel(threadId, { tenantId, ownerId })`: the thread's run on this instance is aborted, its
 * paused run dropped (its pauses withdrawn); else its execution running on another instance gets a
 * cancel request (#360). Another tenant's thread does not exist for the caller (#261).
 */
export async function cancelThread(
  parts: CancelThreadParts,
  threadId: string,
  options: CancelOptions,
): Promise<CancelOutput> {
  const { deps, live, paused, trees } = parts;
  const thread = { tenantId: options.tenantId ?? DEFAULT_TENANT_ID, threadId };
  const request = { operation: ExecutionOperation.Cancel, ...thread };
  await parts.admit(request, () => parts.known({ ...thread, ownerId: options.ownerId }));
  const running = live.abort(thread);
  const waiting = await paused.drop(thread);
  // a running resume completes its own Tern when the abort stops it
  if (waiting !== undefined && !running) {
    await trees.deleteAllInTree({ tenantId: thread.tenantId, rootExecutionId: waiting.runId });
    await deps.terns.complete(waiting.ternId, cancelledOutcome(waiting));
    const startedVersion = waiting.startedVersion ?? deps.config.version;
    const cancelled = { ...thread, runId: waiting.runId, startedVersion };
    await observeCancelledPause(deps.observer, executionEventAt(cancelled, deps));
  }
  if (running || waiting !== undefined) return { cancelled: true };
  return { cancelled: await remoteCancel(parts, thread, options.ownerId) };
}
