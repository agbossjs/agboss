import type { IncomingMessage, ServerResponse } from "node:http";
import type { Class } from "../../components/injection.js";
import type { HttpCaller } from "../../http/http-auth.js";
import type { HttpAuthenticatorHandler } from "../../http/http-authenticator.js";
import { admitMeshHttp, type MeshHttpAdmission } from "../../mesh/mesh-http-admission.js";
import { MESH_HTTP_HEADER } from "../../mesh/mesh-http.js";
import type { MeshSettings } from "../../mesh/mesh-settings.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../../mesh/mesh-verification.js";
import {
  admitCaller,
  boundToConnection,
  writeRejection,
  type CallerGateOutcome,
} from "../a2a-caller-gate.js";
import type { A2AOperation } from "../a2a-caller.js";
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

/** The authenticator's answer for an external caller; with none, an anonymous caller bound to its connection. */
export async function externalCallerOf(
  binding: PeerGateBinding,
  request: PeerGateRequest,
): Promise<CallerGateOutcome> {
  const { req, res } = request;
  // no authenticator (an application with no tenantContext): an anonymous caller, bound to its connection
  if (binding.authenticator === undefined)
    return { isAdmitted: true as const, caller: boundToConnection({}, req) };
  const asked = {
    operation: request.operation,
    ...(request.taskId === undefined || request.taskId === "" ? {} : { taskId: request.taskId }),
  };
  const asking = { ...asked, http: req };
  return admitCaller(binding.authenticator, asking, res, binding.log, binding.onError);
}
