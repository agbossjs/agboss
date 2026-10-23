import { createHash } from "node:crypto";
import { currentFrame, rootFactsOf, type Frame } from "../flow/context/frame.js";
import { amountOf, isoDurationOf } from "./mesh-durations.js";
import { ENVELOPE_LIFETIME } from "./mesh-defaults.js";
import type { MeshEnvelope } from "./mesh-envelope.js";
import { encodeMeshEnvelope } from "./mesh-envelope-codec.js";
import { contextMeshSettingsOf, signingKeyOf } from "./mesh-settings.js";

/**
 * What an AGBoss client sends with a call made inside an execution (#398): the envelope, a W3C
 * `traceparent` and the step's idempotency key. With the application's `mesh.signingKey` the
 * envelope is signed (EdDSA) and binds `bodyHash`, `issuedAt` and `expiresIn`; it claims what the
 * execution may still spend and how long the call may take. Outside an execution's frame (a script,
 * a test's `new A2AClient(…)`), or in a frame without a call chain, nothing.
 */
export interface OutboundMesh {
  /** The envelope, encoded (`agboss-mesh` / `_meta["agboss.dev/mesh"]`). */
  readonly envelope: string;
  /** `00-<trace id>-<span id>-01`: the caller's trace continued, else one of its root execution. */
  readonly traceparent: string;
  /** `executionContext.step.idempotencyKey` of the call (MCP `_meta.callId`). */
  readonly idempotencyKey: string;
  /** `sha256:<hex>` of the body sent: what the receiver's run report must name. */
  readonly bodyHash: string;
}

const hexOf = (text: string, length: number): string =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

/** `sha256:<hex>` of a request's body as sent. */
export const bodyHashOf = (body: string): string =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;

/** The envelope's claims of what the calling execution has left: budget and time. */
function claimsOf(frame: Frame, now: Date): Pick<MeshEnvelope, "budget" | "deadline"> {
  const call = frame.services.meshCall;
  const left = call?.remainingBudget();
  const deadlineAt = call?.deadlineAt.getTime() ?? Date.parse(frame.execution.deadline?.at ?? "");
  return {
    ...(left === undefined ? {} : { budget: { remaining: amountOf(left), currency: "USD" } }),
    ...(Number.isNaN(deadlineAt)
      ? {}
      : { deadline: { remaining: isoDurationOf(deadlineAt - now.getTime()) } }),
  };
}

/** The envelope of a call made in `frame`; `undefined` when its tree has no call chain. */
function envelopeOf(frame: Frame, bodyHash: string, now: Date): MeshEnvelope | undefined {
  const { execution, step } = frame;
  const root = rootFactsOf(execution);
  if (root.mesh === undefined) return undefined;
  const parentExecutionId = execution.parent?.execution.executionId;
  const tool = frame.services.meshCall?.tool;
  return {
    schema: 1,
    issuer: execution.tenant.application.name,
    origin: {
      rootExecutionId: root.executionId,
      executionId: execution.executionId,
      ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
      workflow: { name: execution.workflow.name, version: execution.workflow.version },
      step: {
        component: step.component.name,
        idempotencyKey: step.idempotencyKey,
        ...(tool === undefined ? {} : { tool }),
      },
    },
    callChain: root.mesh.chain,
    issuedAt: now.toISOString(),
    expiresIn: isoDurationOf(ENVELOPE_LIFETIME),
    bodyHash,
    ...claimsOf(frame, now),
  };
}

/**
 * What a call made now with `body` carries: from the current execution frame, if one is open —
 * addressed to `audience` (#398 PR 3: the receiver's application, from the client's `target`).
 */
export function outboundMeshOf(body: string, audience?: string): OutboundMesh | undefined {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return undefined;
  const settings = contextMeshSettingsOf(frame.execution.tenant.application);
  const now = settings?.clock.now() ?? new Date(0);
  const bodyHash = bodyHashOf(body);
  const built = envelopeOf(frame, bodyHash, now);
  if (built === undefined) return undefined;
  const envelope = audience === undefined ? built : { ...built, audience };
  const root = rootFactsOf(frame.execution);
  const traceId = root.mesh?.traceId ?? hexOf(root.executionId, TRACE_ID_LENGTH);
  const spanId = hexOf(frame.step.idempotencyKey, SPAN_ID_LENGTH);
  return {
    envelope: encodeMeshEnvelope(envelope, signingKeyOf(settings)),
    traceparent: `00-${traceId}-${spanId}-01`,
    idempotencyKey: frame.step.idempotencyKey,
    bodyHash,
  };
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The trace id of a W3C `traceparent` (version 00, not all zeros); `undefined` otherwise. */
export function traceIdOf(traceparent: unknown): string | undefined {
  if (typeof traceparent !== "string") return undefined;
  const traceId = TRACEPARENT_PATTERN.exec(traceparent.trim())?.[1];
  return traceId === undefined || /^0+$/.test(traceId) ? undefined : traceId;
}
