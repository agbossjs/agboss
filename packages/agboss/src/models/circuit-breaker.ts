import { AGBossError } from "../core/errors.js";
import { systemClock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";

/** A class decorated with `@ModelProvider` (the fallback of a breaker). */
export type ModelProviderClass = abstract new () => object;

/**
 * `circuitBreakerPolicy`: `failureThreshold` failed calls within `window` open the breaker for
 * `openFor`; while open, calls go to `fallback` or fail fast with `model.circuit-open`.
 */
export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly window: Milliseconds;
  readonly openFor: Milliseconds;
  readonly fallback?: ModelProviderClass;
  /**
   * With a `fallback`: the fallback's model for each model of this provider the workflow uses
   * (`{ "moonshotai/kimi-k2.6": "backup/kimi" }`). Checked at startup: every used model is mapped
   * to one the fallback serves and prices. A fallback call is sent and accounted as that model.
   */
  readonly fallbackModels?: Readonly<Record<string, string>>;
}

/** Codes of a failed model call the framework raises itself. */
export type ModelCallErrorCode = "model.circuit-open";

/** A model call the framework failed itself; `code` on the instance says why (`model.circuit-open`). */
export class ModelCallError extends AGBossError {
  static override readonly code: string = "model";
  override name = "ModelCallError";
  constructor(
    override readonly code: ModelCallErrorCode,
    readonly provider: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/**
 * The process's time in milliseconds: the breakers are shared by every app of the process
 * (`processCircuitBreakers`), so they read the system clock, not an application's.
 */
const systemTime = (): number => systemClock.now().getTime();

/** One provider's breaker: counts failed calls in a sliding window, opens, closes after `openFor`. */
export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | undefined;

  constructor(
    private readonly policy: CircuitBreakerPolicy,
    private readonly now: () => number = systemTime,
  ) {}

  /** Open: calls must not reach the provider. Closes by itself once `openFor` has passed. */
  isOpen(): boolean {
    if (this.openedAt === undefined) return false;
    if (this.now() - this.openedAt < this.policy.openFor) return true;
    this.openedAt = undefined;
    this.failures = [];
    return false;
  }

  recordFailure(): void {
    const now = this.now();
    this.failures = [...this.failures.filter((at) => now - at < this.policy.window), now];
    if (this.failures.length >= this.policy.failureThreshold) this.openedAt = now;
  }

  recordSuccess(): void {
    this.failures = [];
  }
}

/** Breakers shared per provider name — one per process until #121 shares them across processes. */
export class CircuitBreakers {
  private readonly byProvider = new Map<string, CircuitBreaker>();

  constructor(private readonly now: () => number = systemTime) {}

  of(provider: string, policy: CircuitBreakerPolicy): CircuitBreaker {
    const breaker = this.byProvider.get(provider) ?? new CircuitBreaker(policy, this.now);
    this.byProvider.set(provider, breaker);
    return breaker;
  }
}

/** The process's breakers: every app in the process shares a provider's breaker. */
export const processCircuitBreakers = new CircuitBreakers();
