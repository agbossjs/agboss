import { createHash } from "node:crypto";
import { currentFrame, rootFactsOf, type Frame } from "../flow/context/frame.js";
import type { MeshEnvelope } from "./mesh-envelope.js";
import { encodeMeshEnvelope } from "./mesh-envelope-codec.js";

/**
 * What an AGBoss client sends with a call made inside an execution (#398 PR 1): the envelope, a W3C
 * `traceparent` and the step's idempotency key. Outside an execution's frame (a script, a test's
 * `new A2AClient(…)`), or in a frame without a call chain, nothing.
 */
export interface OutboundMesh {
  /** The envelope, encoded (`agboss-mesh` / `_meta["agboss.dev/mesh"]`). */
  readonly envelope: string;
  /** `00-<trace id>-<span id>-01`: the caller's trace continued, else one of its root execution. */
  readonly traceparent: string;
  /** `executionContext.step.idempotencyKey` of the call (MCP `_meta.callId`). */
  readonly idempotencyKey: string;
}

const hexOf = (text: string, length: number): string =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;

/** The envelope of a call made in `frame`; `undefined` when its tree has no call chain. */
function envelopeOf(frame: Frame): MeshEnvelope | undefined {
  const { execution, step } = frame;
  const root = rootFactsOf(execution);
  if (root.mesh === undefined) return undefined;
  const parentExecutionId = execution.parent?.execution.executionId;
  return {
    schema: 1,
    issuer: execution.tenant.application.name,
    origin: {
      rootExecutionId: root.executionId,
      executionId: execution.executionId,
      ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
      workflow: { name: execution.workflow.name, version: execution.workflow.version },
      step: { component: step.component.name, idempotencyKey: step.idempotencyKey },
    },
    callChain: root.mesh.chain,
  };
}

/** What a call made now carries: from the current execution frame, if one is open. */
export function outboundMeshOf(): OutboundMesh | undefined {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return undefined;
  const envelope = envelopeOf(frame);
  if (envelope === undefined) return undefined;
  const root = rootFactsOf(frame.execution);
  const traceId = root.mesh?.traceId ?? hexOf(root.executionId, TRACE_ID_LENGTH);
  const spanId = hexOf(frame.step.idempotencyKey, SPAN_ID_LENGTH);
  return {
    envelope: encodeMeshEnvelope(envelope),
    traceparent: `00-${traceId}-${spanId}-01`,
    idempotencyKey: frame.step.idempotencyKey,
  };
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The trace id of a W3C `traceparent` (version 00, not all zeros); `undefined` otherwise. */
export function traceIdOf(traceparent: unknown): string | undefined {
  if (typeof traceparent !== "string") return undefined;
  const traceId = TRACEPARENT_PATTERN.exec(traceparent.trim())?.[1];
  return traceId === undefined || /^0+$/.test(traceId) ? undefined : traceId;
}
