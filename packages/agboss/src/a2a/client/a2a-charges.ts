import { currentFrame } from "../../flow/context/frame.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { A2ARemotePeer } from "./a2a-card.js";
import type { Accepted } from "./a2a-message.js";
import type { A2ACharged, A2AMeshActivation } from "./a2a-mesh-seam.js";

/**
 * What one call's charges and record are made of (#810, AC3 and AC5): the accept as stored — the
 * same on every pass that reaches it, a replayed one too — so its price and its run report's excess
 * are charged under the call's own ledger identity, once whichever pass writes them; and the peer
 * as the call had it, its step's record saying so when the mesh did not ride.
 */

/** The charges' identity of an accepted call; `now` dates an accept that stored no time. */
export const chargedOf = (accepted: Accepted, clock: Pick<Clock, "now">): A2ACharged => ({
  messageId: accepted.messageId,
  acceptedAt: accepted.acceptedAt ?? clock.now().toISOString(),
  bodyHash: accepted.bodyHash,
  taskId: accepted.taskId,
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
