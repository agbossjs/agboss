import type { AnyTenantApp } from "../app/types.js";

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
