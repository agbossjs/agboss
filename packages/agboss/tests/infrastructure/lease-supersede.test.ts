/**
 * #508 final check — a lease an outbound call's check closed (`leaseStateOf` → `Superseded`): its
 * epoch unchanged, safety rests on the `released` mark alone. On the in-memory and SQLite stores
 * together — the lease store, the outbound-call store and the fenced-effect store of one database —
 * the holder's fenced-effect write at its token is refused like any other of its writes, nothing
 * run. (Its renewal, yield, reclaim and outbound writes are cases of the published
 * `outboundCallContract`, so an external store proves them too.)
 */
import { describe, expect, it } from "vitest";
import { ExecutionFencedError } from "../../src/app/lease-lost.js";
import { OutboundCallLeaseState } from "../../src/infrastructure/execution-lease-event.repository.js";
import type { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import type { FencedEffectRepository } from "../../src/infrastructure/fenced-effect.repository.js";
import type { OutboundCallRepository } from "../../src/infrastructure/outbound-call.repository.js";
import { keyOf, leaseOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { withTarget } from "../../src/testing/contracts/seam.js";
import { seconds } from "../../src/units/index.js";
import { inMemoryFencedEffects, sqliteFencedEffects } from "./contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls, sqliteOutboundCalls } from "./contracts/outbound-call-stores.js";
import { storeTargets, type StoreFactory } from "./contracts/store-kinds.js";

/** One database's three stores, as one instance holds them. */
interface Stores {
  readonly leases: ExecutionLeaseRepository;
  readonly calls: OutboundCallRepository;
  readonly effects: FencedEffectRepository<unknown>;
}

const inMemory: StoreFactory<Stores> = (seam) => {
  const { calls, leases } = inMemoryOutboundCalls(seam);
  return { calls, leases, effects: inMemoryFencedEffects(false)(seam).effects };
};

const sqlite: StoreFactory<Stores> = (seam) => {
  const { calls, leases } = sqliteOutboundCalls(seam);
  return { calls, leases, effects: sqliteFencedEffects(seam).effects };
};

describe.each(storeTargets(inMemory, sqlite))(
  "#508: a lease closed by an outbound call's check ($name)",
  (target) => {
    it(
      "its holder's fenced-effect write at token N is ExecutionFencedError — the work never runs",
      withTarget(target, async ({ clock, first, second }) => {
        const lease = await leaseOf(first, "execution-1", seconds(30));
        await clock.advance(seconds(31));
        const closed = await second.calls.leaseStateOf({
          tenantId: "default",
          leaseExecutionId: "execution-1",
          token: lease.leaseEpoch,
        });
        let isRun = false;

        const write = first.effects.saveResultIfAbsent(keyOf(lease), () => {
          isRun = true;
          return "late";
        });

        expect(closed).toBe(OutboundCallLeaseState.Superseded);
        await expect(write).rejects.toBeInstanceOf(ExecutionFencedError);
        expect(isRun).toBe(false);
      }),
    );
  },
);
