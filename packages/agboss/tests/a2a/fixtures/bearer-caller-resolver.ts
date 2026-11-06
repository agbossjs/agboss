// #808 — the caller resolver of the served fixtures: who calls by their bearer token.
import {
  A2ACallerResolution,
  A2AOperation,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "../../../src/a2a/a2a-caller.js";
import type { Class } from "../../../src/components/injection.js";
import { Injectable } from "../../../src/index.js";

/** What the resolver was asked (#808 AC5), in order; emptied by `resetAsked`. */
export const asked: A2ACallerRequest[] = [];

export const resetAsked = (): void => {
  asked.length = 0;
};

const SENDS: ReadonlySet<A2AOperation> = new Set([
  A2AOperation.SendMessage,
  A2AOperation.SendStreamingMessage,
]);

/** The token of a resolver that throws, and the secret its error carries (never on the wire). */
export const EXPLODING_TOKEN = "explode";
export const RESOLVER_SECRET = "resolver-secret-key-123";

/**
 * `authorization: Bearer <owner>` is that owner, in the tenant `x-tenant` (default `default`);
 * `Bearer <owner>:read-only` is that owner too, but may not answer pauses (403); `Bearer explode` throws; none is unauthenticated.
 */
@Injectable()
export class BearerCallerResolver implements A2ACallerResolver<Class> {
  resolveCaller(request: A2ACallerRequest): A2ACallerResolution<Class> {
    asked.push(request);
    const token = /^Bearer (.+)$/.exec(request.http.headers.authorization ?? "")?.[1];
    if (token === undefined)
      return A2ACallerResolution.unauthenticated({
        reason: "no token",
        challenge: 'Bearer realm="a2a"',
      });
    if (token === EXPLODING_TOKEN) throw new Error(`the resolver failed: ${RESOLVER_SECRET}`);
    const [owner = token, grant] = token.split(":");
    const isResume = SENDS.has(request.operation) && request.taskId !== undefined;
    if (grant === "read-only" && isResume)
      return A2ACallerResolution.forbidden({ reason: "this key may not answer pauses" });
    const tenantId = request.http.headers["x-tenant"];
    return A2ACallerResolution.resolved<Class>({
      ownerId: owner,
      ...(typeof tenantId === "string" ? { tenant: { tenantId } } : {}),
    });
  }
}
