import { causeOptionOf, type PlainErrorOptions } from "../../core/errors.js";
/**
 * `rateLimitPolicy` of a `@ModelProvider` (#266): one limit for the provider's calls, shared by every
 * execution, tenant, parallel branch and application instance — its slots and windows are kept in
 * the application's `RateLimitRepository` (#265). A call without room waits.
 */

/** How a provider's queue shares free slots between the tenants waiting for one (S58, S60). */
export enum QueueBalancingStrategy {
  /** A free slot goes round-robin between the waiting tenants, FIFO inside one (the default, S34). */
  TenantRoundRobin = "tenant-round-robin",
  /** A free slot goes to the waiting tenant with the fewest calls in flight (ties: round-robin). */
  TenantLeastInFlight = "tenant-least-in-flight",
  /** Round-robin where a tenant of `weight` n gets up to n slots per round (`tenant.weight`, S60). */
  TenantWeighted = "tenant-weighted",
  /** One queue in arrival order, no split by tenant. */
  Fifo = "fifo",
}

/** The per-minute caps: calls counted when they start, tokens from the real usage after each call. */
export interface PerMinuteLimits {
  readonly calls?: number;
  readonly tokens?: number;
}

/** `RateLimitPolicy.of({ … })`: at least one limit. */
export interface RateLimitOptions {
  /** Calls in flight at once on this provider, across every instance. */
  readonly maxConcurrentCalls?: number;
  readonly perMinute?: PerMinuteLimits;
  /** How waiting tenants share a free slot; default `TenantRoundRobin`. */
  readonly balancing?: QueueBalancingStrategy;
}

/** A provider's rate limit, checked: every limit a positive integer, the strategy set. */
export interface RateLimitPolicy {
  readonly maxConcurrentCalls: number | undefined;
  readonly perMinute: PerMinuteLimits;
  readonly balancing: QueueBalancingStrategy;
}

/**
 * A value out of range, as the platform's `RangeError`, so `catch` keeps telling it from other errors;
 * made as every framework error is (#906): `{ message, cause }`, with a literal `code`.
 */
export class RateLimitPolicyError extends RangeError {
  static readonly code = "config.rate-limit-policy" as const;
  readonly code = RateLimitPolicyError.code;
  override name = "RateLimitPolicyError";

  constructor(options: PlainErrorOptions) {
    super(options.message, causeOptionOf(options.cause));
  }
}

function checkLimit(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new RateLimitPolicyError({
      message: `${name} must be an integer ≥ 1, got ${String(value)}`,
    });
  }
}

export const RateLimitPolicy = {
  /**
   * `RateLimitPolicy.of({ maxConcurrentCalls: 20, perMinute: { calls: 500, tokens: 400_000 } })` —
   * set it per the provider plan; without a policy a provider has no limit.
   */
  of(options: RateLimitOptions): RateLimitPolicy {
    const perMinute = options.perMinute ?? {};
    checkLimit("maxConcurrentCalls", options.maxConcurrentCalls);
    checkLimit("perMinute.calls", perMinute.calls);
    checkLimit("perMinute.tokens", perMinute.tokens);
    const limits = [options.maxConcurrentCalls, perMinute.calls, perMinute.tokens];
    if (limits.every((limit) => limit === undefined)) {
      throw new RateLimitPolicyError({
        message: "a rate limit needs maxConcurrentCalls or perMinute.calls / perMinute.tokens",
      });
    }
    return Object.freeze({
      maxConcurrentCalls: options.maxConcurrentCalls,
      perMinute: Object.freeze({ ...perMinute }),
      balancing: options.balancing ?? QueueBalancingStrategy.TenantRoundRobin,
    });
  },
};
