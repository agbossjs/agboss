import type { Clock } from "../../infrastructure/clock.js";
import type {
  RateLimitLease,
  RateLimitRepository,
} from "../../infrastructure/rate-limit.repository.js";
import { minutes, seconds } from "../../units/index.js";

/**
 * The room one attempt holds while it runs (#266): its `maxConcurrentCalls` slot in
 * `RateLimitRepository` — a lease, renewed while the call goes on, so a slot of an instance that
 * died is free again after it — released when the attempt ends, with its real usage.
 */

/** How long a slot is held without a renewal (an instance that dies frees it after this). */
export const SLOT_LEASE = minutes(1);
/** How often a held slot is renewed. */
const RENEWAL = seconds(20);

/** What an attempt holds; `release` ends it — once, whatever is called after. */
export interface GatePass {
  /** Frees the room; `tokens` is the call's real usage (the per-minute token window). */
  readonly release: (tokens: number) => Promise<void>;
}

/** A pass that holds nothing: a provider without `rateLimitPolicy` has no limit. */
export const FREE_PASS: GatePass = { release: () => Promise.resolve() };

/** What a held pass reports to its gate when it is released. */
export interface PassRelease {
  readonly tenantId: string;
  readonly tokens: number;
}

/** What a pass needs: the repository and clock, and what to tell the gate at the end. */
export interface PassParts {
  readonly rateLimits: RateLimitRepository;
  readonly clock: Clock;
  readonly onRelease: (release: PassRelease) => Promise<void>;
}

/** Renews the slot on the clock until `stopped` aborts or the lease could not be renewed. */
export async function keepRenewing(
  parts: Pick<PassParts, "rateLimits" | "clock">,
  lease: RateLimitLease,
  stopped: AbortSignal,
): Promise<void> {
  for (;;) {
    await parts.clock.sleep(RENEWAL, stopped);
    if (stopped.aborted) return;
    const renewed = await parts.rateLimits.renew(lease, SLOT_LEASE);
    // an expired slot may be counted free elsewhere: the call goes on, the lease is not taken back
    if (!renewed) return;
  }
}

/** A held pass over `lease` (none without `maxConcurrentCalls`) for one call of `tenantId`. */
export function heldPass(
  parts: PassParts,
  lease: RateLimitLease | undefined,
  tenantId: string,
): GatePass {
  const stopped = new AbortController();
  if (lease !== undefined) {
    // a failed renewal only stops the renewals: the lease then expires by itself
    void keepRenewing(parts, lease, stopped.signal).catch(() => undefined);
  }
  let released = false;
  return {
    release: async (tokens) => {
      if (released) return;
      released = true;
      stopped.abort();
      if (lease !== undefined) await parts.rateLimits.release(lease);
      await parts.onRelease({ tenantId, tokens });
    },
  };
}
