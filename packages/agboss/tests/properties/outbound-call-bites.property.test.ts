/**
 * #533 item 2, AC2: the model-based property bites — a store whose claim does not compare, one whose
 * ending ignores the attempt's owner and one whose lease check reads past the expiry each fail it,
 * shrunk to a short sequence; and a failure reproduces from its seed: the same seed, the same
 * shrunk counterexample.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import type { FencedEffectKey } from "../../src/infrastructure/fenced-effect.repository.js";
import {
  InMemoryOutboundCallRepository,
  type OutboundCallClaim,
  type OutboundCallState,
} from "../../src/infrastructure/outbound-call.repository.js";
import type { OutboundCallStores } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, type InstanceSeam } from "../infrastructure/contracts/store-kinds.js";
import { commandArbitrary, firstDifference } from "./fencing-model.js";

/** `markPending` that does not compare: every claimer wins. */
class UncomparedCalls extends InMemoryOutboundCallRepository {
  override async markPending(
    key: FencedEffectKey,
    _expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    const found = await this.findByKey(key);
    if (found === undefined) return false;
    return super.markPending(
      key,
      { status: found.status, attempt: found.attempt, attemptOwner: found.attemptOwner },
      claim,
    );
  }
}

/** `markCompleted` for whoever asks: the owner ignored. */
class OwnerBlindCalls extends InMemoryOutboundCallRepository {
  override async markCompleted(
    key: FencedEffectKey,
    _owner: string,
    result: string,
  ): Promise<boolean> {
    const found = await this.findByKey(key);
    return found === undefined ? false : super.markCompleted(key, found.attemptOwner, result);
  }
}

const target = (
  make: (
    seam: InstanceSeam,
    leases: InMemoryExecutionLeaseRepository,
  ) => InMemoryOutboundCallRepository,
) =>
  inMemoryTarget((seam): OutboundCallStores => {
    const leases = new InMemoryExecutionLeaseRepository(
      seam.storeClock,
      seam.application,
      seam.database,
    );
    return { calls: make(seam, leases), leases };
  });

const BROKEN = {
  "a claim that does not compare": target(
    (seam, leases) => new UncomparedCalls(seam.storeClock, seam.database, leases),
  ),
  "an ending that ignores the owner": target(
    (seam, leases) => new OwnerBlindCalls(seam.storeClock, seam.database, leases),
  ),
};

/** The property, as a check that reports instead of throwing. */
const checked = (variant: keyof typeof BROKEN, seed: number) =>
  fc.check(
    fc.asyncProperty(
      fc.array(commandArbitrary, { minLength: 1, maxLength: 30 }),
      async (commands) => (await firstDifference(BROKEN[variant], commands)) === undefined,
    ),
    { seed, numRuns: 500 },
  );

describe("#533 AC2: the outbound-call property bites, and reproduces from its seed", () => {
  it.each(["a claim that does not compare", "an ending that ignores the owner"] as const)(
    "%s fails it, shrunk to a short sequence",
    async (variant) => {
      const result = await checked(variant, 533);

      expect(result.failed).toBe(true);
      expect(result.counterexample?.[0].length).toBeLessThanOrEqual(8);
    },
    60_000,
  );

  it("the same seed gives the same shrunk counterexample, and the path replays it", async () => {
    const first = await checked("a claim that does not compare", 4242);
    const again = await checked("a claim that does not compare", 4242);

    expect(first.failed).toBe(true);
    expect(again.counterexample).toEqual(first.counterexample);
    expect(again.counterexamplePath).toBe(first.counterexamplePath);
    const replayed = await fc.check(
      fc.asyncProperty(
        fc.array(commandArbitrary, { minLength: 1, maxLength: 30 }),
        async (commands) =>
          (await firstDifference(BROKEN["a claim that does not compare"], commands)) === undefined,
      ),
      { seed: 4242, path: first.counterexamplePath ?? "", numRuns: 1 },
    );
    expect(replayed.counterexample).toEqual(first.counterexample);
  }, 60_000);
});
