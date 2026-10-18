import type { Environment } from "../flow/generated-types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ProviderCalls } from "./calls/provider-calls.js";
import { providerBaseUrlOf, providerKeyOf } from "./provider-environment.js";
import type { ProviderConnection } from "./handler.js";
import { modelProviderOf, type ModelProviderOptions } from "./model-provider.decorator.js";
import { resilientFetch, type FallbackTarget, type ProviderFetch } from "./resilient-fetch.js";

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

function connect(
  options: ModelProviderOptions,
  connection: ConnectionOptions,
  fallback: FallbackTarget | undefined,
): ProviderConnection {
  const baseUrl = providerBaseUrlOf(options, connection);
  const { calls } = connection;
  const gate = calls?.gateOf(options.name, options.rateLimitPolicy);
  return {
    provider: options.name,
    baseUrl,
    apiKey: providerKeyOf(options, connection, connection.requireKeys),
    fetch: resilientFetch(
      {
        provider: options.name,
        baseUrl,
        timeout: options.timeout,
        retryPolicy: options.retryPolicy,
        ...(calls === undefined
          ? {}
          : { breaker: calls.breakerOf(options.name, options.circuitBreakerPolicy) }),
        ...(gate === undefined ? {} : { gate }),
        ...(fallback === undefined ? {} : { fallback }),
        ...(connection.clock === undefined ? {} : { clock: connection.clock }),
      },
      connection.send ?? ((input, init) => fetch(input, init)),
    ),
  };
}

/**
 * A provider's connection: its base URL, its key from the application's environment, `fetch`
 * with its timeout, rate limit, retry policy and circuit breaker; while the breaker is open, calls
 * go to its fallback provider.
 */
export function connectionOf(
  options: ModelProviderOptions,
  connection: ConnectionOptions,
): ProviderConnection {
  const { fallback: fallbackClass, fallbackModels = {} } = options.circuitBreakerPolicy;
  if (fallbackClass === undefined) return connect(options, connection, undefined);
  const fallbackOptions = modelProviderOf(fallbackClass);
  const fallback: FallbackTarget = {
    ...connect(fallbackOptions, connection, undefined),
    models: fallbackModels,
    cost: fallbackOptions.cost,
  };
  return connect(options, connection, fallback);
}
