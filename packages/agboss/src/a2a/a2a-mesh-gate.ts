import type { ServerResponse } from "node:http";
import type { Class } from "../components/injection.js";
import { nameOf } from "../components/name-of.js";
import type { InboundMesh } from "../mesh/inbound-mesh.js";
import { inboundMeshOfRequest, meshRefusalOf } from "../mesh/mesh-admission.js";
import { TRACEPARENT } from "../mesh/mesh-envelope.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { meshLimitBodyOf } from "../mesh/mesh-wire.js";
import { A2ARoute, type A2AApp, type A2ACallerRequest } from "./a2a-caller.js";
import { writeRejection } from "./a2a-caller-gate.js";

/**
 * The listener's mesh check (#398), after the caller is resolved and before the body is read:
 * a `POST <base>/execute` whose envelope's call chain already passed through this application's
 * start, or is as long as its `maxMeshHops`, is refused — `409 { code, error, details }`
 * (`limit.mesh-loop`, `limit.hops`), nothing runs, no observer event, no record (like a refused
 * caller, #387). An admitted request runs with the chain, which its own calls carry on — and, when
 * the resolver's `peer` is the envelope's verified `signedBy` (PR 2), with what it trusts of it:
 * origin, budget, deadline. A resume continues an execution that has its chain already.
 */

const HTTP_CONFLICT = 409;

/** What the mesh check decided: the chain to run with, or the refusal already written. */
export type MeshGateOutcome =
  { readonly isAdmitted: true; readonly inbound?: InboundMesh } | { readonly isAdmitted: false };

/** Checks an admitted request's call chain at the listener's application and start. */
export function admitMesh(
  app: A2AApp,
  start: Class,
  request: A2ACallerRequest,
  site: { readonly res: ServerResponse; readonly peer: string | undefined },
): MeshGateOutcome {
  const { route, http: req, envelope } = request;
  if (route !== A2ARoute.Execute) return { isAdmitted: true };
  const settings = meshSettingsOf(app);
  if (settings !== undefined) {
    const entry = { application: settings.application, start: nameOf(start) };
    const receiver = { entry, maxMeshHops: settings.maxMeshHops };
    const refusal = meshLimitBodyOf(meshRefusalOf(receiver, envelope));
    if (refusal !== undefined) {
      writeRejection(site.res, HTTP_CONFLICT, refusal);
      req.resume(); // the body is discarded unread
      return { isAdmitted: false };
    }
  }
  const trusted = site.peer !== undefined && site.peer === request.signedBy ? site.peer : undefined;
  const inbound = inboundMeshOfRequest(envelope, req.headers[TRACEPARENT], trusted);
  return inbound === undefined ? { isAdmitted: true } : { isAdmitted: true, inbound };
}
