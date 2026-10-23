import type { InboundMesh } from "./inbound-mesh.js";
import type { MeshEnvelope } from "./mesh-envelope.js";
import {
  HopsLimitExceededError,
  MeshLoopDetectedError,
  type MeshLimitError,
} from "./mesh-errors.js";
import type { MeshEntry } from "./mesh-hop.js";
import { traceIdOf } from "./outbound-mesh.js";

/**
 * A receiver's check of an envelope's call chain (#398 PR 1), before anything runs: its own entry
 * already in the chain → `MeshLoopDetectedError`; the chain as long as its `maxMeshHops` →
 * `HopsLimitExceededError`. Applied to any envelope — trusted or not: a caller can only make its own
 * request fail with it (Security 4).
 */

/** What refuses a request: the receiver's entry and its `maxMeshHops`. */
export interface MeshReceiver {
  readonly entry: MeshEntry;
  readonly maxMeshHops: number;
}

/** The limit an envelope's chain meets at `receiver`; `undefined` when it may run. */
export function meshRefusalOf(
  receiver: MeshReceiver,
  envelope: MeshEnvelope | undefined,
): MeshLimitError | undefined {
  if (envelope === undefined) return undefined;
  const { entry, maxMeshHops } = receiver;
  const chain = envelope.callChain;
  const isLoop = chain.some(
    (hop) => hop.application === entry.application && hop.start === entry.start,
  );
  if (isLoop) return new MeshLoopDetectedError(entry, chain);
  if (chain.length >= maxMeshHops) return new HopsLimitExceededError(entry, chain, maxMeshHops);
  return undefined;
}

/** What an admitted request hands its execution: the envelope's chain and the caller's trace id. */
export function inboundMeshOfRequest(
  envelope: MeshEnvelope | undefined,
  traceparent: unknown,
): InboundMesh | undefined {
  const traceId = traceIdOf(traceparent);
  if (envelope === undefined && traceId === undefined) return undefined;
  const chain = envelope?.callChain ?? [];
  return traceId === undefined ? { chain } : { chain, traceId };
}
