import type { Class, ResolvedAll, Token } from "../components/injection.js";
import type { Milliseconds } from "../units/index.js";
import type { CircuitBreakerPolicy } from "./circuit-breaker-policy.js";
import type { ModelCost } from "./cost.js";
import type { ModelProviderHandler } from "./handler.js";
import { isModelDriver, type ModelDriver } from "./model-driver.js";
import { PromptCaching } from "./prompt-caching.js";
import type { RateLimitPolicy } from "./policies/rate-limit-policy.js";
import { Reasoning } from "./reasoning.js";
import type { RetryPolicy } from "./retry-policy.js";
import { AGBossError, type MessageErrorOptions } from "../core/errors.js";
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

/** An HTTP provider: an OpenAI-compatible server at `baseUrl`, the key in the environment. */
export interface HttpModelProviderOptions {
  /**
   * Identifies the provider (logs, overrides, the keys of its shared state) — never its base URL;
   * kebab-case; the class name in kebab-case when left out (`OpenRouter` → `open-router`).
   */
  readonly name?: string;
  readonly description?: string;
  /** Model names this provider serves; exactly one provider must serve each model. */
  readonly serves: readonly RegExp[];
  /**
   * Per attempt: the response head and a plain answer's body, and — for a streamed answer — the longest
   * it may be quiet between two chunks after its first content (#1125). At most 24 hours
   * (`[limits.timeout-invalid]`, #1141).
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
  /** The server's base URL (`https://openrouter.ai/api/v1`); `baseUrlField` may override it. */
  readonly baseUrl: string;
  /**
   * A text field of the application's environment that sets the base URL when it holds one —
   * `baseUrlField: "openRouterBaseUrl"` with `openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")`
   * (a proxy, a local stub) — no `{ default }`: unset, empty or undeclared → `baseUrl` (#266 S87).
   */
  readonly baseUrlField?: string;
  /**
   * The `Secret` field of the application's environment that holds the key —
   * `apiKey: "openRouterApiKey"` with `openRouterApiKey: secret("OPENROUTER_API_KEY")` in each
   * environment that calls the provider. Omit for a server without a key (a local one).
   */
  readonly apiKey?: string;
  /** Components may override it (`reasoning`). */
  readonly reasoning: Reasoning;
  /** Components may override it (`cache`). */
  readonly promptCaching: PromptCaching;
  readonly deps?: never;
}

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
  /** Model names this provider serves; exactly one provider must serve each model. */
  readonly serves: readonly RegExp[];
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
  readonly baseUrl?: never;
  readonly baseUrlField?: never;
  readonly apiKey?: never;
  /** Unset → `Reasoning.off()`; a component may override it. */
  readonly reasoning?: Reasoning;
  /** Unset → `PromptCaching.off()`; a component may override it. */
  readonly promptCaching?: PromptCaching;
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: D;
}

/**
 * A driver provider (#1313): an independent class — `@ModelProvider({ driver, … }) class X {}` — that
 * speaks one protocol (the `driver`) and owns the model names of its own: `model`, or `models`, a
 * map of role names (`default`, `fast`) to the vendor's model names. No `serves`: a component reaches
 * it through `modelProvider` (its own, its workflow's or its application's), never by a model's name.
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
  /** Components may override it (`promptCaching`). Unset → `PromptCaching.off()`. */
  readonly promptCaching?: PromptCaching;
  readonly serves?: never;
  readonly baseUrl?: never;
  readonly baseUrlField?: never;
  readonly apiKey?: never;
  readonly deps?: never;
}

/** `@ModelProvider({ … })`: where models are served from and how calls to it behave (#266). */
export type ModelProviderOptions =
  HttpModelProviderOptions | TransportModelProviderOptions | DriverModelProviderOptions;

/** The options of a provider that is not a driver one: it serves models by `serves`. */
export type ServingModelProviderOptions = HttpModelProviderOptions | TransportModelProviderOptions;

/** A provider's options as kept: a transport's unset `reasoning` / `promptCaching` filled in (off). */
export type KeptModelProviderOptions = ModelProviderOptions & {
  /** Given, or the class name in kebab-case. */
  readonly name: string;
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
};

/** A driver provider's class: empty — the driver speaks the protocol, so the class has no methods. */
export type DriverModelProviderType = abstract new () => ModelProviderHandler;

/** A class that can be a model provider (an HTTP one is constructed with no arguments). */
export type ModelProviderType = abstract new (...args: never[]) => ModelProviderHandler;

/** An HTTP provider's class: no arguments, `chat` / `routeTo` and `capabilities`, no `complete`. */
export type HttpModelProviderType = abstract new () => ModelProviderHandler &
  Required<Pick<ModelProviderHandler, "capabilities">> & { readonly complete?: never };

/** A transport provider's class: its `deps` as constructor parameters, `complete`, no `chat`. */
export type TransportModelProviderType<D extends readonly Token[]> = abstract new (
  ...args: ResolvedAll<D>
) => ModelProviderHandler &
  Required<Pick<ModelProviderHandler, "complete">> & {
    readonly chat?: never;
  };

const providers = new WeakMap<object, KeptModelProviderOptions>();

export class ModelProviderError extends AGBossError {
  static override readonly code = "config.model-provider" as const;
  declare readonly code: typeof ModelProviderError.code;
  override name = "ModelProviderError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** The options as kept: a transport's unset reasoning and caching are off. */
const keptOf = (options: ModelProviderOptions, name: string): KeptModelProviderOptions =>
  Object.freeze({
    ...options,
    name,
    reasoning:
      options.reasoning ?? (isDriverOptions(options) ? Reasoning.modelDecides() : Reasoning.off()),
    promptCaching: options.promptCaching ?? PromptCaching.off(),
  });

/**
 * A model provider: `@ModelProvider({ baseUrl, … }) class X extends OpenAiCompatibleProvider<F>`
 * (HTTP), or `@ModelProvider({ deps, … }) class X implements ModelProviderHandler` with
 * `complete(request)` (a transport, #385) — both at once does not compile
 * (`[model-provider.both-modes]` at assembly).
 */
export function ModelProvider(
  options: HttpModelProviderOptions,
): <C extends HttpModelProviderType>(value: C) => C;
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
  if (options.serves.length === 0) {
    throw new ModelProviderError({
      message: `@ModelProvider${options.name === undefined ? "" : ` "${options.name}"`}: serves needs at least one pattern`,
    });
  }
  return <C extends ModelProviderType>(value: C): C => {
    const name = resolvedName(options.name, value);
    providers.set(value, keptOf(options, name));
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
    throw new ModelProviderError({
      message: `@ModelProvider${options.name === undefined ? "" : ` "${options.name}"`}: driver is no OpenAiCompatibleDriver(…), OpenRouterDriver(…) or DecisionsDriver(…)`,
    });
  }
  return <C extends DriverModelProviderType>(value: C): C => {
    const name = resolvedName(options.name, value);
    providers.set(value, keptOf(options, name));
    return value;
  };
}

/** The options of a `@ModelProvider` class. */
export function modelProviderOf(cls: object): KeptModelProviderOptions {
  const options = providers.get(cls);
  if (options === undefined) {
    const name = typeof cls === "function" ? cls.name : "a value";
    throw new ModelProviderError({ message: `${name} is not a @ModelProvider class` });
  }
  return options;
}

/** Whether a class (or a value listed in `providers`) is a `@ModelProvider` class. */
export const isModelProviderClass = (value: unknown): value is ModelProviderType =>
  typeof value === "function" && providers.has(value);

/** Whether a provider's options are an HTTP provider's (a base URL), not a transport's. */
export const isHttpProvider = (
  options: ModelProviderOptions,
): options is HttpModelProviderOptions => typeof options.baseUrl === "string";

/** Whether a provider class has the method (its own or inherited). */
export function hasProviderMethod(
  cls: ModelProviderType,
  method: "capabilities" | "chat" | "complete" | "routeTo",
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

/** The `deps` of a transport provider class; none for an HTTP one. */
export const modelProviderDepsOf = (cls: object): readonly Token[] =>
  providers.get(cls)?.deps ?? [];

/** Whether a provider serves a model by name. */
export const servesModel = (options: ModelProviderOptions, model: string): boolean =>
  !isDriverOptions(options) &&
  options.serves.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(model),
  );

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
