import { AGBossError } from "../core/errors.js";
import type { Clock } from "../infrastructure/clock.js";
import type { RateLimitRepository } from "../infrastructure/rate-limit.repository.js";
import type { Milliseconds } from "../units/index.js";

/**
 * `circuitBreakerPolicy`: `failureThreshold` failed calls within `window` open the breaker for
 * `openFor`; while open, calls go to `fallback` or fail fast with `model.circuit-open`.
 */
export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly window: Milliseconds;
  readonly openFor: Milliseconds;
  /** A class decorated with `@ModelProvider`. */
  readonly fallback?: abstract new (...args: never[]) => object;
  /**
   * With a `fallback`: the fallback's model for each model of this provider the workflow uses
   * (`{ "moonshotai/kimi-k2.6": "backup/kimi" }`). Checked at startup: every used model is mapped
   * to one the fallback serves and prices. A fallback call is sent and accounted as that model.
   */
  readonly fallbackModels?: Readonly<Record<string, string>>;
}

/** Codes of a failed model call the framework raises itself. */
export type ModelCallErrorCode = "model.circuit-open";

/** What a model call the framework failed itself takes (#906): why, the provider and the message. */
export interface ModelCallErrorOptions {
  /** Why: `model.circuit-open`. */
  readonly code: ModelCallErrorCode;
  /** The provider's name. */
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}

/** A model call the framework failed itself; `code` on the instance says why (`model.circuit-open`). */
export class ModelCallError extends AGBossError {
  static override readonly code = "model" as const;
  override name = "ModelCallError";
  override readonly code: ModelCallErrorCode;
  /** The provider's name. */
  readonly provider: string;

  constructor(options: ModelCallErrorOptions) {
    const { code, provider, message, cause } = options;
    super(`${code}: ${message}`, { cause });
    this.code = code;
    this.provider = provider;
  }
}

/** Where a breaker keeps its state and reads the time: the application's (#265 S52, #262 S75 d). */
export interface CircuitBreakerStore {
  readonly rateLimits: RateLimitRepository;
  readonly clock: Clock;
}

/** Where a provider's open breaker is kept in `RateLimitRepository`: a pause under this key. */
export const circuitOpenKeyOf = (provider: string): string => `${provider}:circuit-open`;

/**
 * One provider's breaker: counts failed calls in a sliding window, opens for `openFor`, closes by
 * itself. Its state — the failures and the open pause — is in the application's
 * `RateLimitRepository`, so with SQLite (or Redis) it holds on every instance at once; its time is
 * the application's `Clock`.
 */
export class CircuitBreaker {
  readonly #failures: string;
  readonly #open: string;

  constructor(
    provider: string,
    private readonly policy: CircuitBreakerPolicy,
    private readonly store: CircuitBreakerStore,
  ) {
    this.#failures = `${provider}:circuit-failures`;
    this.#open = circuitOpenKeyOf(provider);
  }

  /** Open: calls must not reach the provider. Closes by itself once `openFor` has passed. */
  async isOpen(): Promise<boolean> {
    return (await this.store.rateLimits.pausedUntil(this.#open)) !== undefined;
  }

  /** One failed call; the threshold within the window opens the breaker (its count starts anew). */
  async recordFailure(): Promise<void> {
    const { rateLimits, clock } = this.store;
    const failures = await rateLimits.addToWindow(this.#failures, 1, this.policy.window);
    if ((failures ?? 0) < this.policy.failureThreshold) return;
    await rateLimits.pauseUntil(this.#open, new Date(clock.now().getTime() + this.policy.openFor));
    await rateLimits.clearWindow(this.#failures);
  }

  /** A call that succeeded: the failures counted so far are forgotten. */
  async recordSuccess(): Promise<void> {
    await this.store.rateLimits.clearWindow(this.#failures);
  }
}
