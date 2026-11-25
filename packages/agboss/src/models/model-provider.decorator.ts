import { ConfigError } from "../core/error-families/config-errors.js";
import { recordOptionKeys } from "../components/option-keys.js";
import { MODEL_PROVIDER_KEYS } from "../components/decorator-options.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import type { Milliseconds } from "../units/index.js";
import type { CircuitBreakerPolicy } from "./circuit-breaker-policy.js";
import type { ModelCost } from "./cost.js";
import type { ModelProviderHandler } from "./handler.js";
import { isModelDriver, type ModelDriver } from "./model-driver.js";
import { AUTO_PROMPT_CACHING, type PromptCaching } from "./prompt-caching.js";
import type { RateLimitPolicy } from "./policies/rate-limit-policy.js";
import { Reasoning } from "./reasoning.js";
import type { RetryPolicy } from "./retry-policy.js";
import { resolvedName } from "../flow/names.js";

/**
 * Another `@ModelProvider` class that answers when this one cannot — its breaker is open (or
 * half-open with every probe taken), or a call failed after its retries (a timeout, a 429, a 5xx, a
 * broken connection, a refused key or an unknown model). Chains: the fallback may have its own. Give
 * `{ provider, models }` to say which of its models answers for which of this provider's
 * (`models: { "gpt-4.1": "claude-sonnet-4" }`); without a mapping a role (`default`, `fast`) goes to the
 * fallback's same role, any other name is sent as it is. Never on a caller's cancel or a request the
 * provider refused as wrong (a 400, an input it cannot take).
 */
export type ModelFallback =
  | Class
  | {
      readonly provider: Class;
      /** The fallback's model for each model of this provider, by the model's vendor name. */
      readonly models?: Readonly<Record<string, string>>;
    };

/**
 * A transport provider (#385): the class's `complete(request)` makes the call (an SDK, a gateway
 * with its own authorisation), its services through `deps`; no base URL, no key.
 */
export interface TransportModelProviderOptions<D extends readonly Token[] = readonly Token[]> {
  /**
   * Identifies the provider (logs, overrides, the keys of its shared state) — never its base URL;
   * kebab-case; the class name in kebab-case when left out (`OpenRouter` → `open-router`).
   */
  readonly name?: string;
  readonly description?: string;
  /**
   * Per attempt: the response head and a plain answer's body, and — for a streamed answer — the longest
   * it may be quiet between two chunks after its first content (#1125).
   */
  readonly timeout: Milliseconds;
  /** Omit: the calls are unpriced (`CostSource.Unpriced`, 0 USD, tokens counted) — a subscription or a local model. */
  readonly cost?: ModelCost;
  /** Retries one call: attempts and backoff (the only place backoff is set). Omit: no retry. */
  readonly retryPolicy?: RetryPolicy;
  /**
   * How many calls go to the provider and how everyone slows down after a 429 — one limit for the
   * whole application, shared by every instance through `RateLimitRepository`. Omit: no limit.
   */
  readonly rateLimitPolicy?: RateLimitPolicy;
  /** Stops calling a provider that is down for a while (its state in `RateLimitRepository`). Omit: no breaker. */
  readonly circuitBreakerPolicy?: CircuitBreakerPolicy;
  /** Where calls go when this provider is down: its breaker is open, or a call used up its retries. Omit: they fail. */
  readonly fallback?: ModelFallback;
  /** The model of a component that names none (and no `models.default`). */
  readonly model?: string;
  /** Role names to the vendor's model names: `{ default: "gpt-4.1", fast: "gpt-4.1-mini" }`. */
  readonly models?: Readonly<Record<string, string>>;
  /** A transport has no driver: its class makes the calls. */
  readonly driver?: never;
  /** Unset → `Reasoning.off()`; a component may override it. */
  readonly reasoning?: Reasoning;
  /** Unset → automatic caching where supported (the system prompt, tools and history, 5 minutes); a component may override it. */
  readonly promptCaching?: PromptCaching;
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: D;
}

/**
 * A driver provider (#1313): an independent class — `@ModelProvider({ driver, … }) class X {}` — that
 * speaks one protocol (the `driver`) and owns the model names of its own: `model`, or `models`, a
 * map of role names (`default`, `fast`) to the vendor's model names. A component reaches it through
 * `modelProvider` (its own, its workflow's or its application's), never by a model's name.
 */
export interface DriverModelProviderOptions {
  /** Identifies the provider (logs, overrides, the keys of its shared state); the class name in kebab-case when left out. */
  readonly name?: string;
  readonly description?: string;
  /** The protocol and the connection: `OpenAiCompatibleDriver(…)`, `OpenRouterDriver(…)`, `DecisionsDriver(…)`. */
  readonly driver: ModelDriver;
  /** Per attempt: the response head and a plain answer's body; between two chunks of a streamed one (#1125). */
  readonly timeout: Milliseconds;
  /** Omit: the calls are unpriced (`CostSource.Unpriced`, 0 USD, tokens counted) — a subscription or a local model. */
  readonly cost?: ModelCost;
  /** Retries one call: attempts and backoff (the only place backoff is set). Omit: no retry. */
  readonly retryPolicy?: RetryPolicy;
  /** How many calls go to the provider and how everyone slows down after a 429. Omit: no limit. */
  readonly rateLimitPolicy?: RateLimitPolicy;
  /** Stops calling a provider that is down for a while (its state in `RateLimitRepository`). Omit: no breaker. */
  readonly circuitBreakerPolicy?: CircuitBreakerPolicy;
  /** Where calls go when this provider is down: its breaker is open, or a call used up its retries. Omit: they fail. */
  readonly fallback?: ModelFallback;
  /** The model of a component that names none (and no `models.default`). */
  readonly model?: string;
  /**
   * Role names to the vendor's model names — `{ default: "gpt-4.1", fast: "gpt-4.1-mini" }`: a
   * component's `model: "fast"` is the name here, any other name goes to the server as written.
   */
  readonly models?: Readonly<Record<string, string>>;
  /** Components may override it (`reasoning`). Unset → `Reasoning.modelDecides()`. */
  readonly reasoning?: Reasoning;
  /** Components may override it (`promptCaching`). Unset → the provider's: automatic caching where supported. */
  readonly promptCaching?: PromptCaching;
  readonly deps?: never;
}

/** `@ModelProvider({ … })`: where models are served from and how calls to it behave (#266). */
export type ModelProviderOptions = TransportModelProviderOptions | DriverModelProviderOptions;

/** A provider's options as kept: a transport's unset `reasoning` / `promptCaching` filled in (off). */
export type KeptModelProviderOptions = ModelProviderOptions & {
  /** Given, or the class name in kebab-case. */
  readonly name: string;
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
};

/** A driver provider's class: empty — the driver speaks the protocol, so the class has no methods. */
export type DriverModelProviderType = abstract new () => ModelProviderHandler;

/** A class that can be a model provider. */
export type ModelProviderType = abstract new (...args: never[]) => ModelProviderHandler;

/** A transport provider's class: its `deps` as constructor parameters and `complete`. */
export type TransportModelProviderType<D extends readonly Token[]> = abstract new (
  ...args: ResolvedAll<D>
) => ModelProviderHandler & Required<Pick<ModelProviderHandler, "complete">>;

const providers = new WeakMap<object, KeptModelProviderOptions>();

/** The options as kept: a transport's unset reasoning is off and any unset caching is `auto`. */
const keptOf = (options: ModelProviderOptions, name: string): KeptModelProviderOptions =>
  Object.freeze({
    ...options,
    name,
    reasoning:
      options.reasoning ?? (isDriverOptions(options) ? Reasoning.modelDecides() : Reasoning.off()),
    promptCaching: options.promptCaching ?? AUTO_PROMPT_CACHING,
  });

/** Keeps a provider's options, and the keys it was given that `@ModelProvider` does not take. */
function keepProvider(value: object, options: ModelProviderOptions, name: string): void {
  recordOptionKeys(value, "ModelProvider", options, MODEL_PROVIDER_KEYS);
  providers.set(value, keptOf(options, name));
}

/**
 * A model provider: `@ModelProvider({ driver, … }) class X {}` (a driver speaks the protocol,
 * #1313), or `@ModelProvider({ deps, … }) class X implements ModelProviderHandler` with
 * `complete(request)` (a transport, #385) — both at once does not compile
 * (`[model-provider.both-modes]` at assembly). A component reaches either through `modelProvider`.
 */
export function ModelProvider<const D extends readonly Token[] = []>(
  options: TransportModelProviderOptions<D>,
): <C extends TransportModelProviderType<D>>(value: C) => C;
export function ModelProvider(
  options: DriverModelProviderOptions,
): <C extends DriverModelProviderType>(value: C) => C;
export function ModelProvider(
  options: ModelProviderOptions,
): <C extends ModelProviderType | DriverModelProviderType>(value: C) => C {
  if (isDriverOptions(options)) return driverProvider(options);
  return <C extends ModelProviderType>(value: C): C => {
    const name = resolvedName(options.name, value);
    keepProvider(value, options, name);
    return value;
  };
}

/** Whether the options are a driver provider's (#1313). */
export const isDriverOptions = (
  options: ModelProviderOptions,
): options is DriverModelProviderOptions => "driver" in options;

/** A driver provider: an empty class and its options; the driver must be one `OpenAiCompatibleDriver(…)` made. */
function driverProvider(
  options: DriverModelProviderOptions,
): <C extends DriverModelProviderType>(value: C) => C {
  if (!isModelDriver(options.driver)) {
    throw new ConfigError.ModelProvider({
      message: `@ModelProvider${options.name === undefined ? "" : ` "${options.name}"`}: driver is no OpenAiCompatibleDriver(…), OpenRouterDriver(…) or DecisionsDriver(…)`,
    });
  }
  return <C extends DriverModelProviderType>(value: C): C => {
    const name = resolvedName(options.name, value);
    keepProvider(value, options, name);
    return value;
  };
}

/** The options of a `@ModelProvider` class. */
export function modelProviderOf(cls: object): KeptModelProviderOptions {
  const options = providers.get(cls);
  if (options === undefined) {
    const name = typeof cls === "function" ? cls.name : "a value";
    throw new ConfigError.ModelProvider({ message: `${name} is not a @ModelProvider class` });
  }
  return options;
}

/** Whether a class (or a value listed in `providers`) is a `@ModelProvider` class. */
export const isModelProviderClass = (value: unknown): value is ModelProviderType =>
  typeof value === "function" && providers.has(value);

/** Whether a provider class has the method (its own or inherited). */
export function hasProviderMethod(
  cls: ModelProviderType,
  method: "capabilities" | "complete" | "decide",
): boolean {
  const prototype: unknown = cls.prototype;
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    method in prototype &&
    typeof Reflect.get(prototype, method) === "function"
  );
}

/** Whether a provider class makes its calls itself (`complete`, #385). */
export const isTransportClass = (cls: ModelProviderType): boolean =>
  hasProviderMethod(cls, "complete");

/** The `deps` of a transport provider class; none for a driver one. */
export const modelProviderDepsOf = (cls: object): readonly Token[] =>
  providers.get(cls)?.deps ?? [];

/** A provider's fallback as its class and the models it maps. */
export interface ResolvedFallback {
  readonly provider: Class;
  readonly models: Readonly<Record<string, string>>;
}

/** The fallback a provider's options name, in the one shape; `undefined` when none. */
export function fallbackOf(options: ModelProviderOptions): ResolvedFallback | undefined {
  const { fallback } = options;
  if (fallback === undefined) return undefined;
  return typeof fallback === "function"
    ? { provider: fallback, models: {} }
    : { provider: fallback.provider, models: fallback.models ?? {} };
}
