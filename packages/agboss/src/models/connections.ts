import type { Clock } from "../infrastructure/clock.js";
import { processCircuitBreakers, type CircuitBreakers } from "./circuit-breaker.js";
import { settingValueIn } from "./environment-variable.js";
import type { ProviderConnection } from "./handler.js";
import { modelProviderOf, type ModelProviderOptions } from "./model-provider.decorator.js";
import { resilientFetch, type FallbackTarget, type ProviderFetch } from "./resilient-fetch.js";

/** How connections are made: the environment, whether keys must be set, the breakers, the raw client. */
export interface ConnectionOptions {
  readonly env: NodeJS.ProcessEnv;
  /** False for `agboss check --models`: model lists are public, a missing key is not a problem there. */
  readonly requireKeys: boolean;
  readonly breakers?: CircuitBreakers;
  /** The raw HTTP client under retries and breakers. Default: global fetch. */
  readonly send?: ProviderFetch;
  /** The application's clock: timeouts, waits between attempts. Default: the system's. */
  readonly clock?: Clock;
}

const keyOf = (options: ModelProviderOptions, connection: ConnectionOptions): string | undefined =>
  options.apiKey === undefined
    ? undefined
    : connection.requireKeys
      ? options.apiKey.requireIn(connection.env)
      : options.apiKey.valueIn(connection.env);

function connect(
  options: ModelProviderOptions,
  connection: ConnectionOptions,
  fallback: FallbackTarget | undefined,
): ProviderConnection {
  const baseUrl = settingValueIn(options.baseUrl, connection.env);
  const breakers = connection.breakers ?? processCircuitBreakers;
  return {
    provider: options.name,
    baseUrl,
    apiKey: keyOf(options, connection),
    fetch: resilientFetch(
      {
        provider: options.name,
        baseUrl,
        timeout: options.timeout,
        retryPolicy: options.retryPolicy,
        breaker: breakers.of(options.name, options.circuitBreakerPolicy),
        ...(fallback === undefined ? {} : { fallback }),
        ...(connection.clock === undefined ? {} : { clock: connection.clock }),
      },
      connection.send ?? ((input, init) => fetch(input, init)),
    ),
  };
}

/**
 * A provider's connection: base URL and key from the environment, `fetch` with its timeout, retry
 * policy and circuit breaker; while the breaker is open, calls go to its fallback provider.
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
