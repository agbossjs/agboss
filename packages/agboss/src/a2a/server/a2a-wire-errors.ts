import {
  ContentTypeNotSupportedError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  type A2AError,
} from "@a2a-js/sdk/errors";

/**
 * The JSON-RPC errors the server answers (#808, design §4.1.7), each with a fixed text and, where a
 * caller needs one, a stable `code` in its `ErrorInfo` metadata — never an error's own message, a
 * cause or a stack (#807's rule: they may carry internal details or unmasked PII). Anything else a
 * handler throws becomes `internalError()`: `-32603`, "the request failed".
 */

/** `-32602` with a stable code (and, for a caller, plain facts: the skill ids, a schema). */
export const invalidParams = (
  code: string,
  message: string,
  facts: Readonly<Record<string, string>> = {},
): A2AError => new RequestMalformedError({ message, metadata: { code, ...facts } });

/** `-32001`: no such task, or not the caller's (never told apart, spec §3.3). */
export const taskNotFound = (): A2AError => new TaskNotFoundError({ message: "task not found" });

/** `-32002`: the task is over. */
export const taskNotCancelable = (): A2AError =>
  new TaskNotCancelableError({ message: "the task is over: it cannot be canceled" });

/** `-32004` with a stable code. */
export const unsupportedOperation = (code: string, message: string): A2AError =>
  new UnsupportedOperationError({ message, metadata: { code } });

/** `-32005`: a part this agent does not read (a file: `raw`, `url`). */
export const contentTypeNotSupported = (): A2AError =>
  new ContentTypeNotSupportedError({
    message: "the agent reads text and data parts only",
    metadata: { code: "a2a.content-type" },
  });

/** `-32003`: no push notifications. */
export const pushNotSupported = (): A2AError =>
  new PushNotificationNotSupportedError({ message: "push notifications are not supported" });

/**
 * `-32004`: no extended card — the card declares `capabilities.extendedAgentCard: false`, and an
 * operation of a capability not declared is `UnsupportedOperationError` (spec §3.3.4; `-32007` is
 * for an agent that declares one and has none configured; the TCK's CORE-CAP-003, #811).
 */
export const extendedCardUnsupported = (): A2AError =>
  new UnsupportedOperationError({
    message: "this agent has no extended agent card",
    metadata: { code: "a2a.no-extended-card" },
  });

/** An unexpected failure: a plain error with a fixed text, which the binding sends as `-32603`. */
export class A2AInternalError extends Error {
  override name = "A2AInternalError";

  constructor() {
    super("the request failed");
  }
}
