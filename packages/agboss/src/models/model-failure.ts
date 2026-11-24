/** Why a model call failed — what a retry policy may retry on. */
export enum ModelFailure {
  Timeout = "timeout",
  RateLimited = "rate-limited",
  ServerError = "server-error",
  NetworkError = "network-error",
}

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_SERVER_ERROR = 500;

/** The failure an HTTP status means; `undefined` for a success or a client error (not retried). */
export function failureOfStatus(status: number): ModelFailure | undefined {
  if (status === HTTP_TOO_MANY_REQUESTS) return ModelFailure.RateLimited;
  if (status === HTTP_REQUEST_TIMEOUT) return ModelFailure.Timeout;
  if (status >= HTTP_SERVER_ERROR) return ModelFailure.ServerError;
  return undefined;
}

/** The failure a thrown fetch error means: a timeout, or the network. */
export const failureOfError = (error: unknown): ModelFailure =>
  error instanceof Error && error.name === "TimeoutError"
    ? ModelFailure.Timeout
    : ModelFailure.NetworkError;

/** `Retry-After` in milliseconds (seconds or an HTTP date); `undefined` when absent or unreadable. */
export function retryAfterOf(response: Response, now: number): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Client-error statuses that say the provider cannot serve: its key, its model or endpoint, its quota. */
const PROVIDER_REFUSALS: readonly number[] = [401, 402, 403, 404];
const HTTP_BAD_REQUEST = 400;

/**
 * What an error status that is no retried failure means: `provider` — the provider is at fault (a
 * refused key, an unknown model or endpoint, a used-up quota) —, `request` — the request was wrong —,
 * or `undefined` below 400.
 */
export function refusalOfStatus(status: number): "provider" | "request" | undefined {
  if (status < HTTP_BAD_REQUEST) return undefined;
  return PROVIDER_REFUSALS.includes(status) ? "provider" : "request";
}
