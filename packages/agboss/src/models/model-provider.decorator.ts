import type { ResolvedAll, Token } from "../components/injection.js";
import type { Milliseconds } from "../units/index.js";
import type { CircuitBreakerPolicy } from "./circuit-breaker.js";
import type { ModelCost } from "./cost.js";
import type { ModelProviderHandler } from "./handler.js";
import { PromptCaching } from "./prompt-caching.js";
import type { RateLimitPolicy } from "./policies/rate-limit-policy.js";
import { Reasoning } from "./reasoning.js";
import type { RetryPolicy } from "./retry-policy.js";

/** What every `@ModelProvider` says, HTTP or a transport (#385). */
interface ModelProviderBaseOptions {
  /**
   * Identifies the provider (logs, overrides, the keys of its shared state) — never its base URL;
   * kebab-case ending with `-model-provider` (`[name.kind-suffix]`).
   */
  readonly name: string;
  readonly description: string;
  /** Model names this provider serves; exactly one provider must serve each model. */
  readonly serves: readonly RegExp[];
  /** Per attempt. */
  readonly timeout: Milliseconds;
  readonly cost: ModelCost;
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

/** An HTTP provider: an OpenAI-compatible server at `baseUrl`, the key in the environment. */
export interface HttpModelProviderOptions extends ModelProviderBaseOptions {
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
export interface TransportModelProviderOptions<
  D extends readonly Token[] = readonly Token[],
> extends ModelProviderBaseOptions {
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

/** `@ModelProvider({ … })`: where models are served from and how calls to it behave (#266). */
export type ModelProviderOptions = HttpModelProviderOptions | TransportModelProviderOptions;

/** A provider's options as kept: a transport's unset `reasoning` / `promptCaching` filled in (off). */
export type KeptModelProviderOptions = ModelProviderOptions & {
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
};

/** A class that can be a model provider (an HTTP one is constructed with no arguments). */
export type ModelProviderType = abstract new (...args: never[]) => ModelProviderHandler;

/** An HTTP provider's class: no arguments, `chat` / `routeTo` and `capabilities`, no `complete`. */
type HttpModelProviderType = abstract new () => ModelProviderHandler &
  Required<Pick<ModelProviderHandler, "capabilities">> & { readonly complete?: never };

/** A transport provider's class: its `deps` as constructor parameters, `complete`, no `chat`. */
type TransportModelProviderType<D extends readonly Token[]> = abstract new (
  ...args: ResolvedAll<D>
) => ModelProviderHandler &
  Required<Pick<ModelProviderHandler, "complete">> & {
    readonly chat?: never;
  };

const providers = new WeakMap<object, KeptModelProviderOptions>();

export class ModelProviderError extends Error {
  override name = "ModelProviderError";
}

/** The options as kept: a transport's unset reasoning and caching are off. */
const keptOf = (options: ModelProviderOptions): KeptModelProviderOptions =>
  Object.freeze({
    ...options,
    reasoning: options.reasoning ?? Reasoning.off(),
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
export function ModelProvider(options: ModelProviderOptions) {
  if (options.serves.length === 0) {
    throw new ModelProviderError(
      `@ModelProvider "${options.name}": serves needs at least one pattern`,
    );
  }
  return <C extends ModelProviderType>(value: C): C => {
    providers.set(value, keptOf(options));
    return value;
  };
}

/** The options of a `@ModelProvider` class. */
export function modelProviderOf(cls: object): KeptModelProviderOptions {
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
  options.serves.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(model),
  );
