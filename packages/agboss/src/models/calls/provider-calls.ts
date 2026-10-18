import type { Clock } from "../../infrastructure/clock.js";
import type { RateLimitRepository } from "../../infrastructure/rate-limit.repository.js";
import { CircuitBreaker, type CircuitBreakerPolicy } from "../circuit-breaker.js";
import type { RateLimitPolicy } from "../policies/rate-limit-policy.js";
import { ProviderGate } from "./provider-gate.js";

/**
 * What the model calls of one application instance share (#266): its `RateLimitRepository` and
 * `Clock` — where every provider's rate-limit state, 429 pause and circuit breaker live — and one
 * gate per provider (its tenant-fair queue and AIMD level are per instance).
 */
export class ProviderCalls {
  readonly #gates = new Map<string, ProviderGate>();

  constructor(
    readonly rateLimits: RateLimitRepository,
    readonly clock: Clock,
  ) {}

  /** The provider's gate; none without `rateLimitPolicy` (no limit). */
  gateOf(provider: string, policy: RateLimitPolicy | undefined): ProviderGate | undefined {
    if (policy === undefined) return undefined;
    const known = this.#gates.get(provider);
    if (known !== undefined) return known;
    const gate = new ProviderGate({
      provider,
      policy,
      rateLimits: this.rateLimits,
      clock: this.clock,
    });
    this.#gates.set(provider, gate);
    return gate;
  }

  /** The provider's breaker: its state in the repository, so every breaker of it agrees. */
  breakerOf(provider: string, policy: CircuitBreakerPolicy): CircuitBreaker {
    return new CircuitBreaker(provider, policy, { rateLimits: this.rateLimits, clock: this.clock });
  }
}

const byRepository = new WeakMap<RateLimitRepository, ProviderCalls>();

/** The calls of the instance whose repository this is: one per instance, every workflow shares it. */
export function providerCallsOf(rateLimits: RateLimitRepository, clock: Clock): ProviderCalls {
  const known = byRepository.get(rateLimits);
  if (known !== undefined) return known;
  const calls = new ProviderCalls(rateLimits, clock);
  byRepository.set(rateLimits, calls);
  return calls;
}
