import type { Milliseconds } from "../units/index.js";
import type { CircuitBreakerPolicy } from "./circuit-breaker.js";
import type { ModelCost } from "./cost.js";
import type { SettingValue } from "./environment-variable.js";
import type { ModelProviderHandler } from "./handler.js";
import type { PromptCaching } from "./prompt-caching.js";
import type { RateLimitPolicy } from "./policies/rate-limit-policy.js";
import type { Reasoning } from "./reasoning.js";
import type { RetryPolicy } from "./retry-policy.js";

/**
 * `@ModelProvider({ … })`: where models are served from and how calls to it behave — application
 * infrastructure (#266), listed only in `@Application({ providers })`.
 */
export interface ModelProviderOptions {
  /**
   * Identifies the provider (logs, overrides, the keys of its shared state) — never its base URL;
   * kebab-case ending with `-model-provider` (`[name.kind-suffix]`).
   */
  readonly name: string;
  readonly description: string;
  /** Model names this provider serves; exactly one provider must serve each model. */
  readonly serves: readonly RegExp[];
  readonly baseUrl: SettingValue;
  /**
   * The `Secret` field of the application's environment that holds the key —
   * `apiKey: "openRouterApiKey"` with `openRouterApiKey: secret("OPENROUTER_API_KEY")` in each
   * environment that calls the provider. Omit for a server without a key (a local one).
   */
  readonly apiKey?: string;
  /** Per attempt. */
  readonly timeout: Milliseconds;
  readonly cost: ModelCost;
  /** Components may override it (`thinking` until #152). */
  readonly reasoning: Reasoning;
  /** Components may override it (`cache` until #152). */
  readonly promptCaching: PromptCaching;
  /** Retries one call: attempts and backoff (the only place backoff is set). */
  readonly retryPolicy: RetryPolicy;
  /**
   * How many calls go to the provider and how everyone slows down after a 429 — one limit for the
   * whole application, shared by every instance through `RateLimitRepository`. Omit: no limit.
   */
  readonly rateLimitPolicy?: RateLimitPolicy;
  /** Stops calling a provider that is down for a while (its state in `RateLimitRepository`). */
  readonly circuitBreakerPolicy: CircuitBreakerPolicy;
}

/** A class that can be a model provider: constructed with no arguments, implements the handler. */
export type ModelProviderType = abstract new () => ModelProviderHandler;

const providers = new WeakMap<object, ModelProviderOptions>();

export class ModelProviderError extends Error {
  override name = "ModelProviderError";
}

/** A model provider: `@ModelProvider({ … }) class X extends OpenAiCompatibleProvider<Fields>`. */
export function ModelProvider(options: ModelProviderOptions) {
  if (options.serves.length === 0) {
    throw new ModelProviderError(
      `@ModelProvider "${options.name}": serves needs at least one pattern`,
    );
  }
  return <C extends ModelProviderType>(value: C): C => {
    providers.set(value, Object.freeze({ ...options }));
    return value;
  };
}

/** The options of a `@ModelProvider` class. */
export function modelProviderOf(cls: object): ModelProviderOptions {
  const options = providers.get(cls);
  if (options === undefined) {
    const name = typeof cls === "function" ? cls.name : "a value";
    throw new ModelProviderError(`${name} is not a @ModelProvider class`);
  }
  return options;
}

/** Whether a class (or a value listed in `providers`) is a `@ModelProvider` class. */
export const isModelProviderClass = (value: unknown): value is ModelProviderType =>
  typeof value === "function" && providers.has(value);

/** Whether a provider serves a model by name. */
export const servesModel = (options: ModelProviderOptions, model: string): boolean =>
  options.serves.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(model),
  );
