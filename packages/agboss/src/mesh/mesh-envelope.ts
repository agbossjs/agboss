import type { WorkflowRecord } from "../flow/context/execution-context.js";
import type { MeshHop } from "./mesh-hop.js";

/**
 * The mesh envelope (#398 PR 1): what an AGBoss call to another application carries besides its
 * input — A2A in the `agboss-mesh` request header, MCP in `_meta["agboss.dev/mesh"]`, both as a
 * compact JWS: signed (`EdDSA`) when the caller's `@Application({ mesh: { signingKey } })` is set,
 * else unsecured (`alg: "none"`). On the receiver it is a **claim** — parsed into
 * `A2ACallerRequest.envelope` — trusted (its `budget`, `deadline`, `origin` and idempotency key)
 * only when the caller resolver names an authenticated `peer` and the signature is that peer's
 * (PR 2). Its `callChain` is applied anyway — a loop or the hops limit refuses the request; a caller
 * can only make its own request fail with it. Ids only: no `ownerId`, no `tenantId`, no input values.
 */
export interface MeshEnvelope {
  /** The envelope's version: `1`. */
  readonly schema: 1;
  /** The calling application, `@Application({ name })` — as claimed. */
  readonly issuer: string;
  /**
   * The receiving application it is meant for (#398 PR 3: the client's `target.application`): a
   * receiver of another name refuses it (`401 mesh.audience-mismatch`) — no forwarding.
   */
  readonly audience?: string;
  /** Where in the caller the call was made — as claimed. */
  readonly origin: MeshOrigin;
  /** The applications the request passed through, the first caller first, the caller last. */
  readonly callChain: readonly MeshHop[];
  /** When the caller signed it (ISO 8601, its `Clock`) — signed envelopes (#398 PR 2). */
  readonly issuedAt?: string;
  /** How long it is valid after `issuedAt` (ISO 8601 duration, `PT60S`): the replay window. */
  readonly expiresIn?: string;
  /** `sha256:<hex>` of the request's body (A2A) or arguments (MCP): binds it to this call. */
  readonly bodyHash?: string;
  /** What the calling execution may still spend: the receiver lowers its own limit to it. */
  readonly budget?: MeshBudgetClaim;
  /** How long the caller still waits: the receiver's execution deadline. */
  readonly deadline?: MeshDeadlineClaim;
}

/** The calling execution's budget left, in its values' units: `{ remaining: "0.42", currency: "USD" }`. */
export interface MeshBudgetClaim {
  readonly remaining: string;
  readonly currency: "USD";
}

/** The time the caller still waits, as an ISO 8601 duration: `{ remaining: "PT58.2S" }`. */
export interface MeshDeadlineClaim {
  readonly remaining: string;
}

/**
 * Where an execution's request came from (#398 PR 2): the calling application and its execution,
 * workflow and step, and how many applications the chain had passed through — set only for a
 * request from an authenticated peer whose envelope's signature was verified
 * (`executionContext.origin`, `ExecutionRecord.origin`, `ExecutionEvent.origin`).
 */
export interface ExecutionOrigin extends MeshOrigin {
  /** The calling application: the verified `peer`. */
  readonly application: string;
  /** The applications of the call chain before this one. */
  readonly hops: number;
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
  /** The tool that called, when a tool call made it (`ask-billing-tool`, #398 PR 2). */
  readonly tool?: string;
}

/** The A2A request header that carries the envelope. */
export const MESH_HEADER = "agboss-mesh";

/** The MCP `_meta` key that carries the envelope. */
export const MESH_META_KEY = "agboss.dev/mesh";

/** The MCP `_meta` key of a mesh limit on an error result (`{ code, error, details }`). */
export const MESH_ERROR_META_KEY = "agboss.dev/error";

/**
 * What a receiver tells its caller of the run (#398 PR 2), signed by the receiver's `signingKey`:
 * `A2AExecutionResponse.report`, `_meta["agboss.dev/report"]` over MCP. A caller records `spend` as
 * a service's spend only when it verifies the report with that application's `verifyKey`.
 */
export interface MeshRunReport {
  readonly schema: 1;
  /** The receiving application. */
  readonly issuer: string;
  /** Its execution of the request. */
  readonly executionId: string;
  /** What the execution spent: `{ total: "0.031", currency: "USD" }`. */
  readonly spend: MeshSpendReport;
  /** The request's `bodyHash`: binds the report to the call. */
  readonly bodyHash: string;
  /** When it was signed (ISO 8601, the receiver's `Clock`). */
  readonly issuedAt: string;
}

/** A spend in its values' units. */
export interface MeshSpendReport {
  readonly total: string;
  readonly currency: "USD";
}

/** The MCP `_meta` key of a receiver's signed `MeshRunReport`. */
export const MESH_REPORT_META_KEY = "agboss.dev/report";

/** The W3C trace-context header (`_meta.traceparent` over MCP). */
export const TRACEPARENT = "traceparent";
