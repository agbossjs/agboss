import type { AnyTenantApp } from "../app/types.js";
import { AGBossError } from "../core/errors.js";

/**
 * What `a2aHttpListener` needs of an application (#387, #808): its `execute` / `resume` /
 * `cancel`, and `resolve` — the listener takes its authenticator and stores from the
 * application's container. Both `createApp`'s app and `testWith`'s `app` are one.
 */
export type A2AApp = Pick<AnyTenantApp, "execute" | "resume" | "cancel" | "resolve">;

/**
 * The A2A v1.0 operation a request asks for (#808): its JSON-RPC method — what an authenticator
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

/** The codes an A2A rejection carries on the wire (`{ code, error }`). */
export const A2A_CALLER_CODES = {
  unauthenticated: "a2a.caller-unauthenticated",
  forbidden: "a2a.caller-forbidden",
  resolutionFailed: "a2a.caller-resolution-failed",
} as const;

/** What a rejected caller takes (#906): the status, the wire code and the server's reason. */
export interface A2ACallerRejectedErrorOptions {
  /** `401` or `403`. */
  readonly httpStatus: number;
  /** The code the server sent (`{ code, error }`): `a2a.caller-unauthenticated`, `a2a.caller-forbidden`, … */
  readonly wireCode: string;
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * The A2A server refused the caller (#387): `A2AClient.send` on a `401` / `403` carrying an
 * `a2a.caller-*` code — `httpStatus`, `wireCode` (`a2a.caller-unauthenticated`,
 * `a2a.caller-forbidden`) and the server's reason in the message. Its `code` is the class's,
 * `a2a.caller-rejected`, like every `AGBossError` (#457). Nothing ran on the server.
 */
export class A2ACallerRejectedError extends AGBossError {
  /** `a2a.caller-rejected`. */
  static override readonly code = "a2a.caller-rejected" as const;
  declare readonly code: typeof A2ACallerRejectedError.code;
  /** `A2ACallerRejectedError`. */
  override name = "A2ACallerRejectedError";

  /** `401` or `403`. */
  readonly httpStatus: number;
  /** The code the server sent (`{ code, error }`): `a2a.caller-unauthenticated`, `a2a.caller-forbidden`, … */
  readonly wireCode: string;
  /** The server's reason, as it said it. */
  readonly reason: string;

  constructor(options: A2ACallerRejectedErrorOptions) {
    const { httpStatus, wireCode, reason, cause } = options;
    super(`the A2A server rejected the caller (${String(httpStatus)} ${wireCode}): ${reason}`, {
      cause,
    });
    this.httpStatus = httpStatus;
    this.wireCode = wireCode;
    this.reason = reason;
  }
}
