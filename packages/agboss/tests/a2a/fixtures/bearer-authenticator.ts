// #808 — the authenticator of the served fixtures: who calls by their bearer token.
import { A2AOperation } from "../../../src/a2a/a2a-caller.js";
import {
  HttpAuthenticator,
  HttpAuthResult,
  HttpSecurity,
  type HttpAuthRequest,
} from "../../../src/index.js";

/** What the authenticator was asked (#808 AC5), in order; emptied by `resetAsked`. */
export const asked: HttpAuthRequest[] = [];

export const resetAsked = (): void => {
  asked.length = 0;
};

const SENDS: ReadonlySet<string | undefined> = new Set<string | undefined>([
  A2AOperation.SendMessage,
  A2AOperation.SendStreamingMessage,
]);

/** The token of an authenticator that throws, and the secret its error carries (never on the wire). */
export const EXPLODING_TOKEN = "explode";
export const RESOLVER_SECRET = "resolver-secret-key-123";

/**
 * `authorization: Bearer <owner>` is that owner, in the tenant `x-tenant` (default `default`);
 * `Bearer <owner>:read-only` is that owner too, but may not answer pauses (403); `Bearer explode` throws; none is unauthenticated.
 */
@HttpAuthenticator({ schemes: [HttpSecurity.bearer()] })
export class BearerAuthenticator {
  authenticate(request: HttpAuthRequest): HttpAuthResult {
    asked.push(request);
    const token = /^Bearer (.+)$/.exec(request.http.headers.authorization ?? "")?.[1];
    if (token === undefined)
      return HttpAuthResult.unauthenticated("no token", { challenge: 'Bearer realm="a2a"' });
    if (token === EXPLODING_TOKEN) throw new Error(`the resolver failed: ${RESOLVER_SECRET}`);
    const [owner = token, grant] = token.split(":");
    const isResume = SENDS.has(request.operation) && request.taskId !== undefined;
    if (grant === "read-only" && isResume)
      return HttpAuthResult.forbidden("this key may not answer pauses");
    const tenantId = request.http.headers["x-tenant"];
    return HttpAuthResult.authenticated({
      ownerId: owner,
      ...(typeof tenantId === "string" ? { tenant: { tenantId } } : {}),
    });
  }
}
