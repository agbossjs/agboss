import type { IncomingMessage } from "node:http";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { AGBossError } from "../core/errors.js";
import type { ExecutionOptionsOf } from "../flow/generated-types.js";

/**
 * What `a2aHttpListener` needs of an application (#387, #808): its `execute` / `resume` /
 * `cancel`, and `resolve` — the listener takes its caller resolver and stores from the
 * application's container. Both `createApp`'s app and `testWith`'s `app` are one.
 */
export type A2AApp = Pick<App, "execute" | "resume" | "cancel" | "resolve">;

/**
 * The A2A v1.0 operation a request asks for (#808): its JSON-RPC method — what a caller resolver
 * may allow or refuse per caller (a key that may not answer pauses: `SendMessage` with a `taskId`).
 */
export enum A2AOperation {
  /** A new task, or — with a `taskId` — a follow-up answering a task's pause. */
  SendMessage = "SendMessage",
  /** `SendMessage`, its task's changes streamed back. */
  SendStreamingMessage = "SendStreamingMessage",
  /** One task of the caller's. */
  GetTask = "GetTask",
  /** The caller's tasks. */
  ListTasks = "ListTasks",
  /** A cancel of one task. */
  CancelTask = "CancelTask",
  /** A task's changes streamed, from its current state on. */
  SubscribeToTask = "SubscribeToTask",
}

/**
 * What a caller resolver reads of one request (#387, #808): the operation, the task it names and
 * the raw request — its headers and its socket (a client certificate). The body has been read
 * (bounded by `maxBodySize`) and parsed to find the operation and the task, nothing more: nothing
 * of it is trusted or acted on before the resolver decides.
 */
export interface A2ACallerRequest {
  /** What the request asks for. */
  readonly operation: A2AOperation;
  /**
   * The task it names: `GetTask`, `CancelTask`, `SubscribeToTask`, and a follow-up `SendMessage` /
   * `SendStreamingMessage` (a resume). A claim of the caller, unchecked: `undefined` for a new task
   * and `ListTasks`.
   */
  readonly taskId?: string;
  /** The raw request: headers, socket — its body is not the resolver's. */
  readonly http: IncomingMessage;
}

/**
 * Who calls, for the start's application: its tenant (the declared `TenantContext`'s values,
 * required when the application declares one), the thread's owner and the declared
 * `ExecutionContext`'s values — what `app.execute(Start, input, options)` takes of them.
 */
export type A2ACaller<TStart extends Class> = Pick<
  ExecutionOptionsOf<InstanceType<TStart>>,
  "tenant" | "ownerId" | "execution"
> &
  A2APeer;

/**
 * The mesh peer a resolver authenticated (#398 PR 2): the calling application by its
 * `@Application({ name })`, as its transport proved it (mTLS, an API key) — kept with the tasks it
 * sends (#808).
 */
export interface A2APeer {
  readonly peer?: string;
}

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
 * before anything of it runs — the tenant is never guessed from the request by the framework.
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
 * `a2a.caller-*` code — `httpStatus`, `wireCode` (`a2a.caller-unauthenticated`,
 * `a2a.caller-forbidden`) and the server's reason in the message. Its `code` is the class's,
 * `a2a.caller-rejected`, like every `AGBossError` (#457). Nothing ran on the server.
 */
export class A2ACallerRejectedError extends AGBossError {
  /** `a2a.caller-rejected`. */
  static override readonly code: string = "a2a.caller-rejected";
  /** `A2ACallerRejectedError`. */
  override name = "A2ACallerRejectedError";

  constructor(
    /** `401` or `403`. */
    readonly httpStatus: number,
    /** The code the server sent (`{ code, error }`): `a2a.caller-unauthenticated`, `a2a.caller-forbidden`, … */
    readonly wireCode: string,
    reason: string,
  ) {
    super(`the A2A server rejected the caller (${String(httpStatus)} ${wireCode}): ${reason}`);
  }
}
