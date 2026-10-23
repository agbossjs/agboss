import type { IncomingMessage, ServerResponse } from "node:http";
import type { Class } from "../components/injection.js";
import { nameOf } from "../components/name-of.js";
import type { InboundMesh } from "../mesh/inbound-mesh.js";
import { inboundMeshOfRequest, meshRefusalOf } from "../mesh/mesh-admission.js";
import { MESH_HEADER, TRACEPARENT, type MeshEnvelope } from "../mesh/mesh-envelope.js";
import { meshEnvelopeOf } from "../mesh/mesh-envelope-codec.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { meshLimitBodyOf } from "../mesh/mesh-wire.js";
import { A2ARoute, type A2AApp, type A2ACallerRequest } from "./a2a-caller.js";
import { writeRejection } from "./a2a-caller-gate.js";

/**
 * The listener's mesh check (#398 PR 1), after the caller is resolved and before the body is read:
 * a `POST <base>/execute` whose envelope's call chain already passed through this application's
 * start, or is as long as its `maxMeshHops`, is refused — `409 { code, error, details }`
 * (`limit.mesh-loop`, `limit.hops`), nothing runs, no observer event, no record (like a refused
 * caller, #387). An admitted request runs with the chain, which its own calls carry on. A resume
 * continues an execution that has its chain already: nothing is checked.
 */

const HTTP_CONFLICT = 409;

/** What the mesh check decided: the chain to run with, or the refusal already written. */
export type MeshGateOutcome =
  { readonly isAdmitted: true; readonly inbound?: InboundMesh } | { readonly isAdmitted: false };

/** The envelope of a request's `agboss-mesh` header; `undefined` when none can be read. */
export const requestEnvelopeOf = (req: IncomingMessage): MeshEnvelope | undefined =>
  meshEnvelopeOf(req.headers[MESH_HEADER]);

/** Checks an admitted request's call chain at the listener's application and start. */
export function admitMesh(
  app: A2AApp,
  start: Class,
  request: A2ACallerRequest,
  res: ServerResponse,
): MeshGateOutcome {
  const { route, http: req, envelope } = request;
  if (route !== A2ARoute.Execute) return { isAdmitted: true };
  const settings = meshSettingsOf(app);
  if (settings !== undefined) {
    const entry = { application: settings.application, start: nameOf(start) };
    const receiver = { entry, maxMeshHops: settings.maxMeshHops };
    const refusal = meshLimitBodyOf(meshRefusalOf(receiver, envelope));
    if (refusal !== undefined) {
      writeRejection(res, HTTP_CONFLICT, refusal);
      req.resume(); // the body is discarded unread
      return { isAdmitted: false };
    }
  }
  const inbound = inboundMeshOfRequest(envelope, req.headers[TRACEPARENT]);
  return inbound === undefined ? { isAdmitted: true } : { isAdmitted: true, inbound };
}
