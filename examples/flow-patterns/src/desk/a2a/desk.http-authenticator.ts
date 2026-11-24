import { HttpAuthenticator, HttpAuthResult, type HttpAuthRequest } from "@agboss/core";
import { A2AOperation } from "@agboss/core/a2a";

/** The addresses of this host: the desk serves its neighbours on the same machine only. */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who calls the desk over A2A — decided by the host from the request's socket and headers and the
 * operation it asks for, never the rest of its body: a caller on this host, for the tenant it names. The desk never pauses, so nobody
 * answers a pause through it.
 */
@HttpAuthenticator({
  description: "Authenticates the helpline's callers by the tenant header, on this host only",
})
export class DeskHttpAuthenticator {
  authenticate(request: HttpAuthRequest): Promise<HttpAuthResult> {
    return Promise.resolve(this.resolutionOf(request));
  }

  private resolutionOf(request: HttpAuthRequest): HttpAuthResult {
    if (!LOOPBACK.has(request.http.socket.remoteAddress ?? "")) {
      return HttpAuthResult.forbidden("the desk serves callers on this host only");
    }
    if (request.operation === A2AOperation.SendMessage && request.taskId !== undefined) {
      return HttpAuthResult.forbidden("the desk never pauses");
    }
    const tenantId = request.http.headers["x-tenant-id"];
    if (typeof tenantId !== "string" || tenantId === "") {
      return HttpAuthResult.unauthenticated("no x-tenant-id header");
    }
    return HttpAuthResult.authenticated({ tenant: { tenantId }, ownerId: `a2a:${tenantId}` });
  }
}
