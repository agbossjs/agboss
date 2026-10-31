import { ExecutionOperation } from "../core/observability.js";
import { keyTextRuleOf } from "../core/errors.js";
import { checkedCallerId, checkedTenantId } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { InvalidThreadIdError, type ThreadAccess } from "../run/thread.js";
import { remoteCancel, type CancelParts } from "./cancel-requests.js";
import type { LiveRuns } from "./live-runs.js";
import { cancelledPaused } from "./cancel-paused.js";
import type { ExecutionRequest } from "./run-events.js";
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
  const { live, paused } = parts;
  const thread = { tenantId: options.tenantId ?? DEFAULT_TENANT_ID, threadId };
  const request = { operation: ExecutionOperation.Cancel, ...thread };
  await parts.admit(request, () => {
    // #552: the tenant id and the thread id are a key's text, as at execute — refused, never echoed
    checkedTenantId(thread.tenantId);
    const rule = keyTextRuleOf(threadId);
    if (rule !== undefined) throw new InvalidThreadIdError(rule);
    checkedCallerId("CancelOptions", "ownerId", options.ownerId); // #589
    return parts.known({ ...thread, ownerId: options.ownerId });
  });
  const running = live.abort(thread);
  // a running resume completes its own Tern when the abort stops it
  if (running) {
    await paused.drop(thread);
    return { cancelled: true };
  }
  // paused (its run in the shared store): withdrawn, undone (#340), cancelled — after the undo
  if (await cancelledPaused(parts, thread)) return { cancelled: true };
  return { cancelled: await remoteCancel(parts, thread, options.ownerId) };
}
