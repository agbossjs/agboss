import { currentFrame } from "../../flow/context/frame.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { A2ARemotePeer } from "./a2a-card.js";
import type { Task } from "@a2a-js/sdk";
import type { Accepted } from "./a2a-message.js";
import {
  A2AClientOperation,
  A2AProtocolError,
  A2ARemoteCallError,
  A2ARemoteCallReason,
} from "./a2a-client-errors.js";
import { meshRefusalOf } from "./a2a-outcome.js";
import type { A2ACharged, A2AMeshActivation } from "./a2a-mesh-seam.js";

/**
 * What one call's charges and record are made of (#810, AC3 and AC5): the accept as stored — the
 * same on every pass that reaches it, a replayed one too — so its price and its run report's excess
 * are charged under the call's own ledger identity, once whichever pass writes them; and the peer
 * as the call had it, its step's record saying so when the mesh did not ride.
 */

/** The charges' identity of an accepted call; `now` dates an accept that stored no time. */
export const chargedOf = (accepted: Accepted, clock: Pick<Clock, "now">): A2ACharged => {
  const now = clock.now();
  return {
    messageId: accepted.messageId,
    acceptedAt: accepted.acceptedAt ?? now.toISOString(),
    bodyHash: accepted.bodyHash,
    taskId: accepted.taskId,
    now,
  };
};

/** The same, at the task's end: its `now` the time of the settle (the report's latest date). */
export const settledChargeOf = (charged: A2ACharged, clock: Pick<Clock, "now">): A2ACharged => ({
  ...charged,
  now: clock.now(),
});

/**
 * The peer as the call had it — the mesh rode when the accept says so, this pass's or the one a
 * replay read —; a call without it is said in the step's record (`remote: { …, mesh: false }`).
 */
export function settledPeerOf(
  activation: A2AMeshActivation,
  accepted: Accepted,
  application: string,
): A2ARemotePeer {
  const peer = { ...activation.peer, mesh: activation.peer.mesh && accepted.isMeshed };
  if (!peer.mesh && accepted.taskId !== undefined) {
    const remote = { application, executionId: accepted.taskId, mesh: false } as const;
    currentFrame()?.services.meshCall?.recordRemote(remote);
  }
  return peer;
}

/**
 * A call the agent refused at the accept, before anything ran (#849: its task `REJECTED` — a mesh
 * loop, a chain past `maxMeshHops`), as the accept stored it: charged nothing, said in the step's
 * record (`remote: { …, refused: true }`, with `mesh: false` when the mesh did not ride).
 */
export function recordRefused(
  activation: A2AMeshActivation,
  accepted: Accepted,
  application: string,
): void {
  if (accepted.taskId === undefined) return;
  const isMeshed = activation.peer.mesh && accepted.isMeshed;
  currentFrame()?.services.meshCall?.recordRemote({
    application,
    executionId: accepted.taskId,
    ...(isMeshed ? {} : { mesh: false as const }),
    refused: true,
  });
}

/** What `refusedCall` needs of the call: its agent, its task, a read of it, its charge and record. */
export interface RefusedCall {
  readonly agent: string;
  readonly taskId: string | undefined;
  /** `GetTask` of the task, as the agent has it now. */
  readonly read: (taskId: string) => Promise<Task>;
  /** Charges the call's price (the ledger adds it once). */
  readonly charge: () => void;
  /** Records the call as refused (`remote.refused: true`). */
  readonly record: () => void;
}

/**
 * A call the agent refused at the accept (#849, as stored — a replay's too): never waited on and
 * none of its output used. The refusal is the agent's word, so the task is read once more: still
 * `REJECTED` with its mesh limit → charged nothing, recorded `refused: true`, the limit thrown;
 * anything else (working, completed, another end, another task) contradicts the refusal → the
 * price charged and `A2AProtocolError` thrown. A read that fails throws its error, nothing charged.
 */
export async function refusedCall(call: RefusedCall): Promise<never> {
  const { agent, taskId } = call;
  if (taskId === undefined) {
    throw new A2ARemoteCallError({ agent, reason: A2ARemoteCallReason.MalformedAnswer });
  }
  const read = await call.read(taskId);
  const refusal = read.id === taskId ? meshRefusalOf(read) : undefined;
  if (refusal !== undefined) {
    call.record();
    throw refusal;
  }
  call.charge();
  throw new A2AProtocolError({ agent, operation: A2AClientOperation.GetTask });
}
