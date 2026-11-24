import type { IncomingMessage } from "node:http";
import type { ExecutionOptionsOf } from "../flow/generated-types.js";

/**
 * The protocol-agnostic result of authenticating an HTTP request (#1316): built by
 * `HttpAuthResult.authenticated(…)` / `.unauthenticated(…)` / `.forbidden(…)`, taken by every
 * listener that takes an `@HttpAuthenticator` (`a2aHttpListener`, and the MCP listener, #1319).
 */

/** What an authenticator reads of one request: the raw request, and what the protocol made of it. */
export interface HttpAuthRequest {
  /** The raw request: headers and socket (a client certificate). Its body is not the authenticator's. */
  readonly http: IncomingMessage;
  /**
   * What the request asks for, in the protocol's words (A2A: the JSON-RPC method, `SendMessage`,
   * `GetTask`, …) — what an authenticator may allow or refuse per caller. Unset when the protocol has none.
   */
  readonly operation?: string;
  /**
   * The task the request names (A2A: a `taskId`): a claim of the caller, unchecked. `undefined`
   * for a new task and for a request that names none.
   */
  readonly taskId?: string;
}

/**
 * Who calls: the tenant (the declared `TenantContext`'s values, required when the application
 * declares one), the thread's owner and the declared `ExecutionContext`'s values — what
 * `app.execute(Start, input, options)` takes of them — and the mesh peer the transport proved.
 */
export type HttpCaller = Pick<ExecutionOptionsOf<object>, "tenant" | "ownerId" | "execution"> & {
  /**
   * The calling application by its `@Application({ name })`, as its transport proved it (mTLS, an
   * API key): kept with the tasks it sends (#398, #808).
   */
  readonly peer?: string;
  /**
   * What a listener's per-caller limits are keyed by, in place of the tenant (an API key's id):
   * unset, the tenant's id.
   */
  readonly rateLimitKey?: string;
};

/** How an authenticator decided on a request. */
export enum HttpAuthKind {
  /** The caller is known: the request runs for its tenant. */
  Authenticated = "authenticated",
  /** The caller is not authenticated: `401`, with `WWW-Authenticate` when a challenge is given. */
  Unauthenticated = "unauthenticated",
  /** The caller is known but may not do this: `403`. */
  Forbidden = "forbidden",
}

declare const httpAuthResult: unique symbol;

/** The caller is known: the request runs with its values. */
export interface AuthenticatedHttpAuthResult {
  /** A mark only `HttpAuthResult.authenticated` / `.unauthenticated` / `.forbidden` give. */
  readonly [httpAuthResult]: true;
  readonly kind: HttpAuthKind.Authenticated;
  /** The tenant, owner and execution values the request runs with. */
  readonly caller: HttpCaller;
}

/** The caller is refused: `reason` goes to it on the wire, `challenge` in `WWW-Authenticate`. */
export interface RejectedHttpAuthResult {
  /** A mark only `HttpAuthResult.authenticated` / `.unauthenticated` / `.forbidden` give. */
  readonly [httpAuthResult]: true;
  readonly kind: HttpAuthKind.Unauthenticated | HttpAuthKind.Forbidden;
  /** The host's reason, sent to the caller. */
  readonly reason: string;
  /** The `WWW-Authenticate` header of a `401`. */
  readonly challenge?: string;
}

/** An authenticator's answer: `HttpAuthResult.authenticated(…)` / `.unauthenticated(…)` / `.forbidden(…)`. */
export type HttpAuthResult = AuthenticatedHttpAuthResult | RejectedHttpAuthResult;

const built = new WeakSet<object>();

const brand = <TResult extends object>(result: TResult): TResult => {
  const frozen = Object.freeze(result);
  built.add(frozen);
  return frozen;
};

/** The only way to build an authenticator's answer: branded, a plain object does not compile. */
export const HttpAuthResult = {
  /** The caller is known: the request runs for `caller.tenant`, owned by `caller.ownerId`. */
  authenticated(caller: HttpCaller): AuthenticatedHttpAuthResult {
    return brand({ kind: HttpAuthKind.Authenticated, caller }) as AuthenticatedHttpAuthResult;
  },
  /** No or unknown credentials: `401`. `reason` is sent to the caller; `challenge` is the `WWW-Authenticate` header. */
  unauthenticated(
    reason: string,
    options: { readonly challenge?: string } = {},
  ): RejectedHttpAuthResult {
    const kind = HttpAuthKind.Unauthenticated;
    const challenge = options.challenge === undefined ? {} : { challenge: options.challenge };
    return brand({ kind, reason, ...challenge }) as RejectedHttpAuthResult;
  },
  /** Known credentials that may not do this: `403`. `reason` is sent to the caller. */
  forbidden(reason: string): RejectedHttpAuthResult {
    return brand({ kind: HttpAuthKind.Forbidden, reason }) as RejectedHttpAuthResult;
  },
} as const;

/**
 * Whether a value is an answer the builders made (an authenticator in plain JS may return
 * anything).
 */
export const isHttpAuthResult = (value: unknown): value is HttpAuthResult =>
  typeof value === "object" && value !== null && built.has(value);
