import type { Milliseconds } from "../units/index.js";
import type { CircuitBreakerPolicy } from "./circuit-breaker.js";
import type { ModelCost } from "./cost.js";
import type { EnvironmentVariable, SettingValue } from "./environment-variable.js";
import type { ModelProviderHandler } from "./handler.js";
import type { PromptCaching } from "./prompt-caching.js";
import type { Reasoning } from "./reasoning.js";
import type { RetryPolicy } from "./retry-policy.js";

/**
 * `@ModelProvider({ … })`: where models are served from and how calls to it behave — application
 * infrastructure (#266), listed only in `@Application({ providers })`.
 */
export interface ModelProviderOptions {
  /** Identifies the provider (logs, overrides, fingerprints) — never its base URL. */
  readonly name: string;
  readonly description: string;
  /** Model names this provider serves; exactly one provider must serve each model. */
  readonly serves: readonly RegExp[];
  readonly baseUrl: SettingValue;
  /** Omit for a server without a key (a local one). */
  readonly apiKey?: EnvironmentVariable;
  /** Per attempt. */
  readonly timeout: Milliseconds;
  readonly cost: ModelCost;
  /** Components may override it (`thinking` until #152). */
  readonly reasoning: Reasoning;
  /** Components may override it (`cache` until #152). */
  readonly promptCaching: PromptCaching;
  readonly retryPolicy: RetryPolicy;
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
