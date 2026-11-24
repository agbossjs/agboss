import { ModelCallError } from "./circuit-breaker.js";
import { ModelProviderFailureError } from "./transport/failure-error.js";
import { isProviderSideCode } from "./model-failure.js";

/** Statuses that are always the provider's: its credential, its quota, its timeout, its load. */
const FAILING_STATUSES: readonly number[] = [401, 402, 408, 429];
/** 403 and 404 are the provider's only when its error says so; else the request's own refusal. */
const AMBIGUOUS_STATUSES: readonly number[] = [403, 404];
const HTTP_SERVER_ERROR = 500;
const MAX_CAUSES = 5;
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const NETWORK_NAMES: ReadonlySet<string> = new Set([
  "TimeoutError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  // SDK errors of an overloaded or throttled provider that carry no HTTP status
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
  "RateLimitError",
  "InternalServerError",
]);
const NETWORK_MESSAGES =
  /fetch failed|socket hang up|connection error|network error|throttl|too many requests|rate limit|service unavailable|timed out/i;

/** The error and its causes, nearest first. */
function* causesOf(error: unknown): Generator<Error> {
  for (let cause = error, depth = 0; cause instanceof Error && depth < MAX_CAUSES; depth++) {
    yield cause;
    cause = cause.cause;
  }
}

/** The HTTP status an error (or one of its causes) carries, when it carries one. */
function statusOf(error: unknown): number | undefined {
  for (const cause of causesOf(error)) {
    const status: unknown = Reflect.get(cause, "status");
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Whether an error says, by its own code or type (SDK errors carry them), the provider is at fault. */
function namesProvider(error: unknown): boolean {
  for (const cause of causesOf(error)) {
    const inner: unknown = Reflect.get(cause, "error");
    const innerCode: unknown =
      typeof inner === "object" && inner !== null ? Reflect.get(inner, "code") : undefined;
    if (
      isProviderSideCode(Reflect.get(cause, "code")) ||
      isProviderSideCode(Reflect.get(cause, "type")) ||
      isProviderSideCode(innerCode)
    )
      return true;
  }
  return false;
}

/** Whether an error is a known network or timeout failure. */
function isNetworkFailure(error: unknown): boolean {
  for (const cause of causesOf(error)) {
    const code: unknown = Reflect.get(cause, "code");
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (NETWORK_NAMES.has(cause.name) || NETWORK_NAMES.has(cause.constructor.name)) return true;
    if (NETWORK_MESSAGES.test(cause.message)) return true;
  }
  return false;
}

/**
 * Whether a failed call is the provider's to answer for — and so goes to the fallback: its breaker
 * open, or the call failed after its retries with a provider-side failure (a timeout, a 429, a 5xx,
 * a broken connection, a refused credential or quota). Never the caller's own cancel, an input the
 * model cannot take, a request refused as wrong (a 400, a 422), a refusal of this request (a 403 or
 * 404 that names no provider-side cause: it would bypass the refusal), or an error of no known
 * class.
 */
export function isFailoverError(error: unknown, caller: AbortSignal | undefined): boolean {
  if (caller?.aborted === true) return false;
  for (const cause of causesOf(error)) {
    if (cause instanceof ModelCallError) return cause.code === "model.circuit-open";
    // a transport says it itself: a timeout, a 429, a server error or the network, all the provider's
    if (cause instanceof ModelProviderFailureError) return true;
  }
  const status = statusOf(error);
  if (status === undefined) return isNetworkFailure(error);
  if (AMBIGUOUS_STATUSES.includes(status)) return namesProvider(error);
  return FAILING_STATUSES.includes(status) || status >= HTTP_SERVER_ERROR;
}
