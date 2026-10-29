import { Injectable } from "@agboss/core";
import {
  A2ACallerResolution,
  A2ARoute,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "@agboss/core/a2a";
import type { DeskWorkflowStart } from "../workflows/desk/desk.workflow-start.js";

/** The addresses of this host: the desk serves its neighbours on the same machine only. */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who calls the desk over A2A — decided by the host from the request's socket and headers, never
 * its body: a caller on this host, for the tenant it names. The desk never pauses, so nobody
 * answers a pause through it.
 */
@Injectable()
export class DeskA2aCallerResolver implements A2ACallerResolver<typeof DeskWorkflowStart> {
  resolveCaller(request: A2ACallerRequest): Promise<A2ACallerResolution<typeof DeskWorkflowStart>> {
    return Promise.resolve(this.resolutionOf(request));
  }

  private resolutionOf(request: A2ACallerRequest): A2ACallerResolution<typeof DeskWorkflowStart> {
    if (!LOOPBACK.has(request.http.socket.remoteAddress ?? "")) {
      return A2ACallerResolution.forbidden({ reason: "the desk serves callers on this host only" });
    }
    if (request.route === A2ARoute.Resume) {
      return A2ACallerResolution.forbidden({ reason: "the desk never pauses" });
    }
    const tenantId = request.http.headers["x-tenant-id"];
    if (typeof tenantId !== "string" || tenantId === "") {
      return A2ACallerResolution.unauthenticated({ reason: "no x-tenant-id header" });
    }
    return A2ACallerResolution.resolved({ tenant: { tenantId }, ownerId: `a2a:${tenantId}` });
  }
}
