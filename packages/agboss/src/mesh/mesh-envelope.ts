import type { WorkflowRecord } from "../flow/context/execution-context.js";
import type { MeshHop } from "./mesh-hop.js";

/**
 * The mesh envelope (#398 PR 1): what an AGBoss call to another application carries besides its
 * input — A2A in the `agboss-mesh` request header, MCP in `_meta["agboss.dev/mesh"]`, both as an
 * unsecured JWS (`alg: "none"`) that PR 2 signs. On the receiver it is a **claim**: parsed into
 * `A2ACallerRequest.envelope`, never trusted for the tenant, a budget, a deadline or the origin. Its
 * `callChain` is applied anyway — a loop or the hops limit refuses the request; a caller can only
 * make its own request fail with it. Ids only: no `ownerId`, no `tenantId`, no input values.
 */
export interface MeshEnvelope {
  /** The envelope's version: `1`. */
  readonly schema: 1;
  /** The calling application, `@Application({ name })` — as claimed. */
  readonly issuer: string;
  /** Where in the caller the call was made — as claimed. */
  readonly origin: MeshOrigin;
  /** The applications the request passed through, the first caller first, the caller last. */
  readonly callChain: readonly MeshHop[];
}

/** The calling execution and step of a mesh call. */
export interface MeshOrigin {
  /** The root execution of the caller's tree. */
  readonly rootExecutionId: string;
  /** The execution that made the call (a child's own, or the root's). */
  readonly executionId: string;
  /** Its parent execution; `undefined` at the root. */
  readonly parentExecutionId?: string;
  /** The calling execution's workflow. */
  readonly workflow: Pick<WorkflowRecord, "name" | "version">;
  /** The step that made the call. */
  readonly step: MeshOriginStep;
}

/** The step of a mesh call: its component and its idempotency key (the call's own). */
export interface MeshOriginStep {
  /** The step's component: the agent whose tool called (`support-agent`), an action, … */
  readonly component: string;
  /** `executionContext.step.idempotencyKey` of the call (a tool call's ends with its call id). */
  readonly idempotencyKey: string;
}

/** The A2A request header that carries the envelope. */
export const MESH_HEADER = "agboss-mesh";

/** The MCP `_meta` key that carries the envelope. */
export const MESH_META_KEY = "agboss.dev/mesh";

/** The MCP `_meta` key of a mesh limit on an error result (`{ code, error, details }`). */
export const MESH_ERROR_META_KEY = "agboss.dev/error";

/** The W3C trace-context header (`_meta.traceparent` over MCP). */
export const TRACEPARENT = "traceparent";
