import { executeWithoutInputCheck } from "../../app/execute-without-input-check.js";
import { withoutRecovery, withReservedExecutionId } from "../../app/tree-control.js";
import type { ExecutionOptions, ExecutionOutput } from "../../app/types.js";
import type {
  A2ADirectMessageRecord,
  A2ADirectMessageReply,
} from "../../infrastructure/a2a-direct-message.repository.js";
import { definedOf } from "../../infrastructure/clock.js";
import { withInboundMesh } from "../../mesh/inbound-mesh.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { inboundMeshOfA2A } from "./a2a-mesh-admission.js";
import { callerOptionsOf, type A2ARequestCaller, type A2AServerParts } from "./a2a-server-parts.js";
import type { ServedSkill } from "./a2a-skills.js";
import { A2AInternalError } from "./a2a-wire-errors.js";

/**
 * One attempt at a direct reply (#860, design §4.1.8 and §4): the skill's root execution under the
 * attempt's reserved id — no recovery continues it (`withoutRecovery`: the caller waits for this
 * pass alone) —, aborted when the caller's connection closes (its model calls with it, its step
 * slots freed) and when `RUN_BOUND` passes, so a run is over before its row's `expiresAt`
 * (`IN_FLIGHT`): a resend never takes over an attempt that may still be calling a model. Its reply
 * is kept by compare-and-set; a failure removes the row — nothing kept — and is `-32603`.
 */

/** How long an attempt's row holds it in flight: a resend waits this long at most. */
export const IN_FLIGHT: Milliseconds = seconds(30);

/** How long an attempt's run may take: strictly within `IN_FLIGHT`. */
export const RUN_BOUND: Milliseconds = seconds(25);

/** The run's execution deadline: the listener's `maxTaskDuration`, within `RUN_BOUND`. */
const deadlineOf = (parts: A2AServerParts): Milliseconds =>
  Math.min(parts.maxTaskDuration ?? RUN_BOUND, RUN_BOUND) as Milliseconds;

/** The caller's signal, aborted too once `RUN_BOUND` passes; `done()` ends the bound. */
function boundedSignal(parts: A2AServerParts, caller: A2ARequestCaller) {
  const bound = new AbortController();
  const done = new AbortController();
  void parts.clock.sleep(RUN_BOUND, done.signal).then(() => {
    if (!done.signal.aborted) bound.abort(new A2AInternalError());
  });
  return {
    signal: AbortSignal.any([caller.signal, bound.signal]),
    done: () => {
      done.abort();
    },
  };
}

/** The execution options of one attempt. */
function optionsOf(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  attempt: A2ADirectMessageRecord,
  signal: AbortSignal,
): ExecutionOptions {
  const { tenant, ownerId, execution } = callerOptionsOf(caller);
  const options = withInboundMesh(
    {
      threadId: attempt.contextId,
      ...(tenant === undefined ? {} : { tenant }),
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(execution === undefined ? {} : { execution }),
      deadline: deadlineOf(parts),
      signal,
    },
    inboundMeshOfA2A(caller.mesh),
  );
  return withoutRecovery(withReservedExecutionId(options, attempt.attemptId), {
    callsModel: attempt.callsModel,
  });
}

/** The reply of a run that reached a finish; a run that rests paused is no reply (a bug: refused). */
function replyOf(result: ExecutionOutput): A2ADirectMessageReply {
  // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
  const finish = definedOf(result.finish, "a direct skill cannot pause (assembly)");
  return { finish: finish.name, output: result.output, spentUsd: result.spend.totalUsd };
}

/** The attempt's run, to its reply; its row removed and `-32603` when it fails. */
export async function ranAttempt(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  attempt: A2ADirectMessageRecord,
  sent: { readonly skill: ServedSkill; readonly input: unknown },
): Promise<A2ADirectMessageReply> {
  const { signal, done } = boundedSignal(parts, caller);
  try {
    const options = optionsOf(parts, caller, attempt, signal);
    return replyOf(
      await executeWithoutInputCheck(parts.app, sent.skill.start, sent.input, options),
    );
  } catch (error) {
    await failedAttempt(parts, attempt);
    throw error;
  } finally {
    done();
  }
}

/** A failed attempt: its row and its files removed, so a resend runs it again. */
async function failedAttempt(
  parts: A2AServerParts,
  attempt: A2ADirectMessageRecord,
): Promise<void> {
  await parts.direct.messages.deleteIfInFlight(attempt, attempt.attemptId);
  await parts.files.store.deleteByOwner({ tenantId: attempt.tenantId, ownerId: attempt.attemptId });
}
