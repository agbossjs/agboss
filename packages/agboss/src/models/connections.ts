import type { Environment } from "../flow/generated-types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ProviderCalls } from "./calls/provider-calls.js";
import { providerBaseUrlOf, providerKeyOf } from "./provider-environment.js";
import type { ProviderConnection } from "./handler.js";
import type { ModelProviderOptions } from "./model-provider.decorator.js";
import { resilientFetch, type ProviderFetch, type ResilienceOptions } from "./resilient-fetch.js";

/** How connections are made: the environments, whether keys must be set, the shared calls, the raw client. */
export interface ConnectionOptions {
  /** The process: the variables of an environment passed as written (not resolved yet). */
  readonly env: NodeJS.ProcessEnv;
  /** The application's environment: the providers' keys (`apiKey`) and base URLs (`baseUrlField`). */
  readonly environment: Environment;
  /** False for `agboss check --models`: model lists are public, a missing key is not a problem there. */
  readonly requireKeys: boolean;
  /**
   * The instance's rate limits, 429 pauses and breakers (`RateLimitRepository`, its clock); absent =
   * none of them (the model check, a recording).
   */
  readonly calls?: ProviderCalls;
  /** The raw HTTP client under retries and breakers. Default: global fetch. */
  readonly send?: ProviderFetch;
  /** The application's clock: timeouts, waits between attempts. Default: the system's. */
  readonly clock?: Clock;
}

/**
 * What every call of a provider runs under — HTTP or a transport (#385): its timeout, retry
 * policy, rate limit and breaker (the last two only with the instance's shared calls).
 */
export function resilienceOf(
  options: ModelProviderOptions,
  connection: Pick<ConnectionOptions, "calls" | "clock">,
): ResilienceOptions {
  const { calls } = connection;
  const gate = calls?.gateOf(options.name, options.rateLimitPolicy);
  return {
    provider: options.name,
    timeout: options.timeout,
    retryPolicy: options.retryPolicy,
    ...(calls === undefined
      ? {}
      : { breaker: calls.breakerOf(options.name, options.circuitBreakerPolicy) }),
    ...(gate === undefined ? {} : { gate }),
    ...(connection.clock === undefined ? {} : { clock: connection.clock }),
  };
}

/**
 * A provider's connection: its base URL, its key from the application's environment, `fetch` with
 * its timeout, rate limit, retry policy and circuit breaker. A transport provider's has no base URL
 * (`""`) and no key. While the breaker is open the chat model calls its fallback (`FallbackChatModel`).
 */
export function connectionOf(
  options: ModelProviderOptions,
  connection: ConnectionOptions,
): ProviderConnection {
  return {
    provider: options.name,
    baseUrl: providerBaseUrlOf(options, connection),
    apiKey: providerKeyOf(options, connection, connection.requireKeys),
    fetch: resilientFetch(
      resilienceOf(options, connection),
      connection.send ?? ((input, init) => fetch(input, init)),
    ),
  };
}
