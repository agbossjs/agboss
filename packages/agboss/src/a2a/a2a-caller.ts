import type { IncomingMessage } from "node:http";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { AGBossError } from "../core/errors.js";
import type { ExecutionOptionsOf } from "../flow/generated-types.js";
import type { MeshEnvelope } from "../mesh/mesh-envelope.js";

/**
 * What `a2aHttpListener` needs of an application (#387): its `execute` / `resume` / `cancel`, and
 * `resolve` — the listener takes its caller resolver from the application's container. Both
 * `createApp`'s app and `testWith`'s `app` are one.
 */
export type A2AApp = Pick<App, "execute" | "resume" | "cancel" | "resolve">;

/** The route of an A2A request: `POST <base>/execute` or `POST <base>/resume`. */
export enum A2ARoute {
  /** `POST <base>/execute`: a run of the start. */
  Execute = "execute",
  /** `POST <base>/resume`: an answer to a pause. */
  Resume = "resume",
}

/**
 * What a caller resolver reads of one request, before its body is read (#387 S2 Q2): the route and
 * the raw request — its headers and its socket (a client certificate), never its body.
 */
export interface A2ACallerRequest {
  /** Which route the request is for. */
  readonly route: A2ARoute;
  /** The raw request: headers, socket — its body is not read yet and is not the resolver's. */
  readonly http: IncomingMessage;
  /**
   * The mesh envelope the request carries (#398, the `agboss-mesh` header), read but **not
   * verified**: a claim of where the call comes from — never the tenant, a budget or a deadline.
   * `undefined` when there is none, or none the listener can read (a malformed header is ignored).
   */
  readonly envelope?: MeshEnvelope;
}

/**
 * Who calls, for the start's application: its tenant (the declared `TenantContext`'s values,
 * required when the application declares one), the thread's owner and the declared
 * `ExecutionContext`'s values — what `app.execute(Start, input, options)` takes of them.
 */
export type A2ACaller<TStart extends Class> = Pick<
  ExecutionOptionsOf<InstanceType<TStart>>,
  "tenant" | "ownerId" | "execution"
>;

/** How a caller resolver decided on a request. */
export enum A2ACallerResolutionKind {
  /** The caller is known: the request runs for its tenant. */
  Resolved = "resolved",
  /** The caller is not authenticated: `401`, with `WWW-Authenticate` when a challenge is given. */
  Unauthenticated = "unauthenticated",
  /** The caller is known but may not do this: `403`. */
  Forbidden = "forbidden",
}

declare const a2aCallerResolution: unique symbol;

/** Built only by `A2ACallerResolution.resolved` / `.unauthenticated` / `.forbidden`. */
interface BuiltA2ACallerResolution {
  readonly [a2aCallerResolution]: true;
}

/** The caller is known: the request runs with its values. */
export interface ResolvedA2ACallerResolution<
  TStart extends Class,
> extends BuiltA2ACallerResolution {
  readonly kind: A2ACallerResolutionKind.Resolved;
  /** The tenant, owner and execution values the request runs with. */
  readonly caller: A2ACaller<TStart>;
}

/** The caller is refused: `reason` goes to it on the wire, `challenge` in `WWW-Authenticate`. */
export interface RejectedA2ACallerResolution extends BuiltA2ACallerResolution {
  readonly kind: A2ACallerResolutionKind.Unauthenticated | A2ACallerResolutionKind.Forbidden;
  /** The host's reason, sent to the caller. */
  readonly reason: string;
  /** The `WWW-Authenticate` header of a `401`. */
  readonly challenge?: string;
}

/** A caller resolver's answer: `A2ACallerResolution.resolved(…)` / `.unauthenticated(…)` / `.forbidden(…)`. */
export type A2ACallerResolution<TStart extends Class> =
  ResolvedA2ACallerResolution<TStart> | RejectedA2ACallerResolution;

/** `A2ACallerResolution.unauthenticated({ reason, challenge? })`. */
export interface A2ACallerUnauthenticatedOptions {
  /** Sent to the caller (`{ code, error: reason }`): the host's own wording. */
  readonly reason: string;
  /** The `WWW-Authenticate` header (`Bearer realm="a2a"`). */
  readonly challenge?: string;
}

/** `A2ACallerResolution.forbidden({ reason })`. */
export interface A2ACallerForbiddenOptions {
  /** Sent to the caller (`{ code, error: reason }`): the host's own wording. */
  readonly reason: string;
}

const built = new WeakSet<object>();

const brand = <TResolution extends object>(resolution: TResolution): TResolution => {
  const frozen = Object.freeze(resolution);
  built.add(frozen);
  return frozen;
};

/** The only way to build a caller resolver's answer (#387): branded, a plain object does not compile. */
export const A2ACallerResolution = {
  /** The caller is known: the request runs for `caller.tenant`, owned by `caller.ownerId`. */
  resolved<TStart extends Class>(caller: A2ACaller<TStart>): ResolvedA2ACallerResolution<TStart> {
    const kind = A2ACallerResolutionKind.Resolved;
    return brand({ kind, caller }) as ResolvedA2ACallerResolution<TStart>;
  },
  /** No or unknown credentials: `401`. */
  unauthenticated(options: A2ACallerUnauthenticatedOptions): RejectedA2ACallerResolution {
    const kind = A2ACallerResolutionKind.Unauthenticated;
    const challenge = options.challenge === undefined ? {} : { challenge: options.challenge };
    return brand({ kind, reason: options.reason, ...challenge }) as RejectedA2ACallerResolution;
  },
  /** Known credentials that may not do this: `403`. */
  forbidden(options: A2ACallerForbiddenOptions): RejectedA2ACallerResolution {
    const kind = A2ACallerResolutionKind.Forbidden;
    return brand({ kind, reason: options.reason }) as RejectedA2ACallerResolution;
  },
} as const;

/**
 * Whether a value is an answer the builders made (a resolver in plain JS may return anything) — of
 * the resolver's start, which the listener's options tie it to.
 */
export const isA2ACallerResolution = <TStart extends Class>(
  value: unknown,
): value is A2ACallerResolution<TStart> =>
  typeof value === "object" && value !== null && built.has(value);

/**
 * Who calls the listener (#387): an `@Injectable` listed in `@Application({ providers })` or a
 * `@Workflow({ providers })`, created by the application's container. It decides on each request
 * before its body is read — the tenant is never guessed from the request by the framework.
 */
export interface A2ACallerResolver<TStart extends Class> {
  /** Decides on one request: `resolved(caller)`, `unauthenticated(…)` or `forbidden(…)`. */
  readonly resolveCaller: (
    request: A2ACallerRequest,
  ) => A2ACallerResolution<TStart> | Promise<A2ACallerResolution<TStart>>;
}

/** The codes an A2A rejection carries on the wire (`{ code, error }`). */
export const A2A_CALLER_CODES = {
  unauthenticated: "a2a.caller-unauthenticated",
  forbidden: "a2a.caller-forbidden",
  resolutionFailed: "a2a.caller-resolution-failed",
} as const;

/**
 * The A2A server refused the caller (#387): `A2AClient.send` on a `401` / `403` carrying an
 * `a2a.caller-*` code — `httpStatus`, `code` (`a2a.caller-unauthenticated`, `a2a.caller-forbidden`)
 * and the server's reason in the message. Nothing ran on the server.
 */
export class A2ACallerRejectedError extends AGBossError {
  /** The class's code; an instance's `code` is the wire code of its rejection. */
  static override readonly code: string = "a2a.caller-rejected";
  /** `A2ACallerRejectedError`. */
  override name = "A2ACallerRejectedError";
  /** The wire code of the rejection. */
  override readonly code: string;

  constructor(
    /** `401` or `403`. */
    readonly httpStatus: number,
    code: string,
    reason: string,
  ) {
    super(`the A2A server rejected the caller (${String(httpStatus)} ${code}): ${reason}`);
    this.code = code;
  }
}
