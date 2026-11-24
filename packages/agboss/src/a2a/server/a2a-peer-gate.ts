import type { IncomingMessage, ServerResponse } from "node:http";
import type { Class } from "../../components/injection.js";
import type { HttpCaller } from "../../http/http-auth.js";
import type { HttpAuthenticatorHandler } from "../../http/http-authenticator.js";
import { admitMeshHttp, type MeshHttpAdmission } from "../../mesh/mesh-http-admission.js";
import { MESH_HTTP_HEADER } from "../../mesh/mesh-http.js";
import type { MeshSettings } from "../../mesh/mesh-settings.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../../mesh/mesh-verification.js";
import { admitCaller, writeRejection, type CallerGateOutcome } from "../a2a-caller-gate.js";
import { A2A_CALLER_CODES, A2AOperation } from "../a2a-caller.js";
import { peerRefusalOf } from "./a2a-mesh-admission.js";

/**
 * Who calls an A2A listener, before the body's envelope or the authenticator (#1320): a signed mesh
 * peer — its `X-AGBoss-Mesh` header verified against the exact request, admitted once, allowed this
 * endpoint — or an external caller the `@HttpAuthenticator` judges, or a refusal already written.
 */

/** What the gate needs of the listener's binding. */
export interface PeerGateBinding {
  readonly mesh: MeshSettings;
  readonly endpoint: Class;
  readonly origin: string;
  readonly authenticator?: HttpAuthenticatorHandler | undefined;
  /** `a2aHttpListener({ allowAnonymous })`: a caller with no authenticator is served, owning nothing. */
  readonly allowAnonymous?: boolean;
  readonly log: Parameters<typeof admitCaller>[3];
  readonly onError?: Parameters<typeof admitCaller>[4];
}

/** One request, as the gate reads it. */
export interface PeerGateRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** The body as received: what the signature binds. */
  readonly raw: string;
  readonly operation: A2AOperation;
  readonly taskId?: string | undefined;
}

const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
};

/** Answers a refusal: its status and its code with the code's fixed text. */
export function refuse(
  res: ServerResponse,
  refusal: { readonly status: number; readonly code: MeshRefusalCode },
): void {
  writeRejection(res, refusal.status, {
    code: refusal.code,
    error: MESH_REFUSAL_TEXT[refusal.code],
  });
}

/**
 * What the mesh header says of the request: a verified peer, an external caller (no header, and the
 * application admits those) or — once answered `401` / `403` / `503`, nothing run — `undefined`.
 */
export async function admittedPeerOf(
  binding: PeerGateBinding,
  request: PeerGateRequest,
): Promise<Exclude<MeshHttpAdmission, { kind: "refused" }> | undefined> {
  const { req, res } = request;
  const received = {
    header: headerOf(req, MESH_HTTP_HEADER.toLowerCase()),
    method: req.method ?? "POST",
    path: req.url ?? "/",
    body: request.raw,
    origin: binding.origin,
  };
  const decision = await admitMeshHttp(binding.mesh, received, binding.endpoint);
  const refusal =
    decision.kind === "peer" ? peerRefusalOf(binding.mesh, decision, request.operation) : decision;
  if (refusal?.kind !== "refused") return decision.kind === "refused" ? undefined : decision;
  refuse(res, refusal);
  return undefined;
}

/** The caller a verified peer is: its tenant (when trusted), owned by `mesh:<peer>`. */
export const callerOfPeer = (peer: {
  readonly peer: string;
  readonly tenantId: string | undefined;
  readonly ownerId: string;
}): HttpCaller => ({
  ownerId: peer.ownerId,
  peer: peer.peer,
  ...(peer.tenantId === undefined ? {} : { tenant: { tenantId: peer.tenantId } }),
});

const LIST_FORBIDDEN = {
  code: "a2a.list-forbidden",
  error: "a caller that names no owner cannot list tasks: it reaches a task by its id",
};

/**
 * The authenticator's answer for an external caller. With none, an anonymous caller — only a
 * listener made with `allowAnonymous` has none, else the mesh refused it already. A caller that names
 * no owner (anonymous, or a tenant's key) owns no task: each of its new tasks is its own capability
 * (`a2a-server-parts.ts`), and listing, which would show others', is `403`.
 */
export async function externalCallerOf(
  binding: PeerGateBinding,
  request: PeerGateRequest,
): Promise<CallerGateOutcome> {
  const { res } = request;
  const gate = await judgedCallerOf(binding, request);
  if (!gate.isAdmitted) return gate;
  if (request.operation === A2AOperation.ListTasks && gate.caller.ownerId === undefined) {
    writeRejection(res, 403, LIST_FORBIDDEN);
    return { isAdmitted: false };
  }
  return gate;
}

async function judgedCallerOf(
  binding: PeerGateBinding,
  request: PeerGateRequest,
): Promise<CallerGateOutcome> {
  const { req, res } = request;
  if (binding.authenticator === undefined)
    return binding.allowAnonymous === true
      ? { isAdmitted: true as const, caller: {} }
      : refusedUnauthenticated(res);
  const asked = {
    operation: request.operation,
    ...(request.taskId === undefined || request.taskId === "" ? {} : { taskId: request.taskId }),
  };
  const asking = { ...asked, http: req };
  return admitCaller(binding.authenticator, asking, res, binding.log, binding.onError);
}

/** A listener with no authenticator and no `allowAnonymous` serves only signed peers: this caller is none. */
function refusedUnauthenticated(res: ServerResponse): CallerGateOutcome {
  writeRejection(res, 401, {
    code: A2A_CALLER_CODES.unauthenticated,
    error: "the request is not from a signed mesh peer",
  });
  return { isAdmitted: false };
}
