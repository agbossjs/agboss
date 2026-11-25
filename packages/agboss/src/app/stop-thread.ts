import { ExecutionOperation } from "../core/observability.js";
import { InvalidThreadIdError, keyTextRuleOf } from "../core/errors.js";
import { checkedCallerId, checkedTenantId } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { cancelledPaused, type CancelCommand } from "./cancel-paused.js";
import { InterruptSettlement, remoteInterrupt } from "./cancel-remote.js";
import { requestChecksOf } from "./request-checks.js";
import { writeCancelRequest } from "./cancel-requests.js";
import type { CancelThreadParts } from "./cancel-thread.js";
import { InterruptKind } from "./interrupt-requests.js";
import {
  InterruptMode,
  StopRequestState,
  type StopOptions,
  type StopOutput,
} from "./interrupt-types.js";

/**
 * `app.stop(threadId, { tenantId, ownerId, reason, mode })` (#1341b): the thread's execution is
 * halted where it stands — what it did is kept, nothing is undone — and its caller's `execute` /
 * `resume` resolves `ExecutionStatus.Stopped`. The twin of `app.cancel`: a run on this instance is
 * marked and told at once (`mode` `Immediate` aborts the step in flight, `AfterStep`, the default,
 * lets it finish and starts none), a paused one is ended here, one on another instance gets the
 * request its holder reads at its next renewal. Idempotent: a stop asked again writes again — the
 * lease store's mark and the tree's key — so one that died half way is completed. `Cancel > Stop`: a
 * thread already cancelled is not stopped.
 */
export async function stopThread(
  parts: CancelThreadParts,
  threadId: string,
  options: StopOptions,
): Promise<StopOutput> {
  const { live } = parts;
  const thread = { tenantId: options.tenantId ?? DEFAULT_TENANT_ID, threadId };
  const request = { operation: ExecutionOperation.Stop, ...thread };
  await parts.admit(request, () => {
    checkedTenantId(thread.tenantId);
    const rule = keyTextRuleOf(threadId);
    if (rule !== undefined) throw new InvalidThreadIdError({ rule });
    checkedCallerId("StopOptions", "ownerId", options.ownerId);
    return parts.known({ ...thread, ownerId: options.ownerId });
  });
  const mode = options.mode ?? InterruptMode.AfterStep;
  const command: CancelCommand = {
    ownerId: options.ownerId,
    reason: options.reason,
    kind: InterruptKind.Stop,
    mode,
  };
  const requestedAt = parts.clock.now().toISOString();
  // a tree moved here: its mark and key first (#909, #1341b), then its holder is told at once
  const trees = live.treesOf(thread);
  for (const tree of trees)
    await writeCancelRequest(parts, tree, {
      ...{ requestedAt, ownerId: options.ownerId ?? null, reason: options.reason },
      ...{ threadId, kind: InterruptKind.Stop, mode },
    });
  if (trees.length > 0) {
    await requestChecksOf(live).checked(thread);
    return { state: StopRequestState.Stopping };
  }
  if (await cancelledPaused(parts, thread, undefined, command))
    return { state: StopRequestState.Stopped };
  const settled = await remoteInterrupt(parts, thread, command);
  return { state: stateOf(settled) };
}

const stateOf = (settled: InterruptSettlement): StopRequestState =>
  settled === InterruptSettlement.Ended
    ? StopRequestState.Stopped
    : settled === InterruptSettlement.Requested
      ? StopRequestState.Stopping
      : StopRequestState.NotRunning;
