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

/** Client-error statuses that always say the provider cannot serve: its credential or its quota. */
const PROVIDER_REFUSALS: readonly number[] = [401, 402];
/** Statuses that are the provider's only when its error body names a provider-side cause. */
const AMBIGUOUS_REFUSALS: readonly number[] = [403, 404];
const HTTP_BAD_REQUEST = 400;

/**
 * Error codes and types of a provider's error body that name the provider's own state: its key, its
 * account, its quota, its region. A 403 or 404 without one is a refusal of this request (a moderated
 * prompt, a model asked for per request): it must neither trip the breaker shared by every tenant nor
 * go to another provider, which would bypass the refusal.
 */
const PROVIDER_SIDE_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "invalid_api_key",
  "incorrect_api_key",
  "authentication_error",
  "billing_not_active",
  "billing_hard_limit_reached",
  "account_deactivated",
  "access_terminated",
  "unsupported_country_region_territory",
]);

/** Whether an error's `code` / `type` (as the SDK carries them, or a JSON body's `error`) names the provider. */
export function isProviderSideCode(code: unknown): boolean {
  return typeof code === "string" && PROVIDER_SIDE_CODES.has(code);
}

/** Whether a provider's error body (JSON text) names a provider-side cause. */
export function isProviderSideBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    const error: unknown =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "error") : undefined;
    if (typeof error !== "object" || error === null) return false;
    return (
      isProviderSideCode(Reflect.get(error, "code")) ||
      isProviderSideCode(Reflect.get(error, "type"))
    );
  } catch {
    return false;
  }
}

/**
 * What an error status that is no retried failure means: `provider` — the provider is at fault (a
 * refused key, a used-up quota; a 403 or 404 only when its `body` says so) —, `request` — the request
 * was wrong or refused (a moderation 403, a per-request 404) —, or `undefined` below 400.
 */
export function refusalOfStatus(status: number, body?: string): "provider" | "request" | undefined {
  if (status < HTTP_BAD_REQUEST) return undefined;
  if (PROVIDER_REFUSALS.includes(status)) return "provider";
  if (AMBIGUOUS_REFUSALS.includes(status) && body !== undefined && isProviderSideBody(body))
    return "provider";
  return "request";
}
