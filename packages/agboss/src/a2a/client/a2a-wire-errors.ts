import { A2AError, A2A_ERROR_CODE, isJsonRpcError, isRestError } from "@a2a-js/sdk/errors";
import { A2ACallerRejectedError } from "../a2a-caller.js";
import { A2AClientOperation, A2AProtocolError } from "./a2a-client-errors.js";
import { A2AOriginError } from "./a2a-guard-errors.js";
import { A2ANetworkError, A2ANotSentError, HttpStatusError } from "./a2a-transport.js";

/**
 * What a failed A2A request says, read into codes (#809): never a remote text. One reading for
 * every binding — an HTTP+JSON error is given the JSON-RPC code of its kind — and one judgement of
 * each failure: whether a send certainly did nothing (`isDefiniteSendFailure`), and whether a wait
 * may try again (`isTransientWireError`).
 */

/** How deep a cause chain is read: a cycle, or a chain longer than this, ends there. */
export const MAX_CAUSES = 8;

/** The causes of `error`, itself first, at most `MAX_CAUSES`. */
function causesOf(error: unknown): readonly unknown[] {
  const causes = [error];
  for (let current = error; causes.length < MAX_CAUSES && current instanceof Error;) {
    current = current.cause;
    causes.push(current);
  }
  return causes;
}

/** The A2A code of each kind of error (spec §5.4), for an HTTP+JSON error that names its kind. */
const CODE_OF_KIND: Readonly<Record<string, number>> = {
  TaskNotFoundError: A2A_ERROR_CODE.TASK_NOT_FOUND,
  TaskNotCancelableError: A2A_ERROR_CODE.TASK_NOT_CANCELABLE,
  PushNotificationNotSupportedError: A2A_ERROR_CODE.PUSH_NOTIFICATION_NOT_SUPPORTED,
  UnsupportedOperationError: A2A_ERROR_CODE.UNSUPPORTED_OPERATION,
  ContentTypeNotSupportedError: A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED,
  InvalidAgentResponseError: A2A_ERROR_CODE.INVALID_AGENT_RESPONSE,
  ExtendedAgentCardNotConfiguredError: A2A_ERROR_CODE.EXTENDED_CARD_NOT_CONFIGURED,
  ExtensionSupportRequiredError: A2A_ERROR_CODE.EXTENSION_SUPPORT_REQUIRED,
  VersionNotSupportedError: A2A_ERROR_CODE.VERSION_NOT_SUPPORTED,
  RequestMalformedError: A2A_ERROR_CODE.INVALID_REQUEST,
};

/**
 * The A2A code one error carries: a JSON-RPC envelope's, an HTTP+JSON error's by its kind, or one
 * the client already read (`A2AProtocolError`).
 */
function codeOfOne(error: unknown): number | undefined {
  if (error instanceof A2AProtocolError) return error.rpcCode;
  if (isJsonRpcError(error)) return error.envelopeCode;
  return error instanceof A2AError ? CODE_OF_KIND[error.name] : undefined;
}

/** The A2A code an error carries (the SDK's mapped error), anywhere in its causes. */
export function rpcCodeOf(error: unknown): number | undefined {
  return causesOf(error)
    .map(codeOfOne)
    .find((code) => code !== undefined);
}

/** The HTTP status an error carries (a status answer, an HTTP+JSON error), anywhere in its causes. */
function httpStatusOf(error: unknown): number | undefined {
  for (const cause of causesOf(error)) {
    if (cause instanceof HttpStatusError) return cause.httpStatus;
    if (isRestError(cause)) return cause.statusCode;
  }
  return undefined;
}

/** The client's own errors, passed on as they are wherever they are in the causes. */
const isOwn = (error: unknown): boolean =>
  error instanceof A2ACallerRejectedError ||
  error instanceof A2ANetworkError ||
  error instanceof A2ANotSentError ||
  error instanceof A2AOriginError ||
  error instanceof A2AProtocolError;

/**
 * The error a failed SDK call is translated to: the abort's own reason when `signal` ended it (a
 * lease lost, a cancel — passed on as it is), the client's own errors as they are, any other as
 * `A2AProtocolError` with its A2A code and HTTP status only — an answer the SDK could not read,
 * whose message may quote the answer, with neither.
 */
export function wireErrorOf(
  error: unknown,
  agent: string,
  operation: A2AClientOperation,
  signal?: AbortSignal,
): unknown {
  if (signal?.aborted === true) return signal.reason;
  const own = causesOf(error).find(isOwn);
  if (own !== undefined) return own;
  const rpcCode = rpcCodeOf(error);
  const httpStatus = httpStatusOf(error);
  return new A2AProtocolError({ agent, operation, rpcCode, httpStatus });
}

/**
 * The A2A codes that answer a request before the agent acts on it (an allowlist): the message is
 * not parsed, not one of a known method, malformed, for no task, an operation, content, extension
 * or version the agent does not take. Any other code — `-32603`, a server's own `-32000…-32099`,
 * one this client does not know — may come after the agent acted.
 */
const NOTHING_DONE = new Set<number>([
  A2A_ERROR_CODE.PARSE_ERROR,
  A2A_ERROR_CODE.INVALID_REQUEST,
  A2A_ERROR_CODE.METHOD_NOT_FOUND,
  A2A_ERROR_CODE.INVALID_PARAMS,
  A2A_ERROR_CODE.TASK_NOT_FOUND,
  A2A_ERROR_CODE.UNSUPPORTED_OPERATION,
  A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED,
  A2A_ERROR_CODE.EXTENSION_SUPPORT_REQUIRED,
  A2A_ERROR_CODE.VERSION_NOT_SUPPORTED,
]);

const HTTP_CLIENT_ERRORS = 400;
const HTTP_SERVER_ERRORS = 500;
/** Statuses that may come after the agent acted, or before it decided: a timeout, a rate limit. */
const HTTP_MAYBE_DONE = new Set([408, 429]);

/** Whether a status says the request was refused before the agent acted: a 4xx but 408, 429. */
const isRefusedStatus = (status: number): boolean =>
  status >= HTTP_CLIENT_ERRORS && status < HTTP_SERVER_ERRORS && !HTTP_MAYBE_DONE.has(status);

/**
 * Whether a failed send certainly did nothing on the agent's side (#657: `isDefiniteFailure`): it
 * was never sent (`A2ANotSentError`), the caller was refused, the agent answered a code of
 * `NOTHING_DONE`, or a status `isRefusedStatus` without a code. A network failure, a 5xx, a
 * timeout, a rate limit, an abort, an unknown code or an answer that could not be read is of
 * unknown outcome: the message may have arrived.
 */
export function isDefiniteSendFailure(error: unknown): boolean {
  if (error instanceof A2ANotSentError || error instanceof A2ACallerRejectedError) return true;
  if (!(error instanceof A2AProtocolError)) return false;
  if (error.rpcCode !== undefined) return NOTHING_DONE.has(error.rpcCode);
  // Stryker disable next-line LogicalOperator: no status (`undefined`) is refused neither way
  return isRefusedStatus(error.httpStatus ?? 0);
}

/**
 * Whether a wait's read (`GetTask`, `SubscribeToTask`) that failed may be tried again: no answer, a
 * read never sent, a 5xx, a timeout or a rate limit, an internal error (`-32603`), an answer that could not be read.
 * A refused caller, an origin refused, any other code or 4xx is the agent's answer: it ends the wait.
 */
export function isTransientWireError(error: unknown): boolean {
  // a read never sent (a token refresh that failed) is safe to try again, as one with no answer
  if (error instanceof A2ANetworkError || error instanceof A2ANotSentError) return true;
  if (!(error instanceof A2AProtocolError)) return false;
  if (error.rpcCode !== undefined) return error.rpcCode === A2A_ERROR_CODE.INTERNAL_ERROR;
  const status = error.httpStatus;
  return status === undefined || status >= HTTP_SERVER_ERRORS || HTTP_MAYBE_DONE.has(status);
}

/** Whether a subscribe's error says only that the task already ended (`-32004`, either binding). */
export const isEndedAtSubscribe = (error: unknown): boolean =>
  rpcCodeOf(error) === A2A_ERROR_CODE.UNSUPPORTED_OPERATION;
