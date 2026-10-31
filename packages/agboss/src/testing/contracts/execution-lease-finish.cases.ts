import { expect } from "vitest";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** A tree's lease for 30 s. */
const LEASE = seconds(30);

/** The lease of `root-1` taken by `store` (the first acquire of a free key must take it). */
async function takenBy(store: ExecutionLeaseRepository): Promise<ExecutionLease> {
  const held = await store.acquire("default", "root-1", LEASE);
  if (held === undefined) throw new Error("the first acquire of a free tree must take its lease");
  return held;
}

/**
 * A finished lease (#520): its holder gave it up for good, the work under it over (an
 * `AnyInstance` child answered or failed). No `acquire` gets that key again — not another instance,
 * not the holder, not after any time —, so a stale instance never takes over finished work; it is
 * matched as `release` matches (another holder's lease is kept), and renewed, yielded and reclaimed
 * no more.
 */
export const LEASE_FINISH_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "a finished lease is never taken again: not by another instance, not by its holder, not after it would have expired",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      await first.finish(await takenBy(first));

      const byOther = await second.acquire("default", "root-1", LEASE);
      const byHolder = await first.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(31));
      const later = await second.acquire("default", "root-1", LEASE);

      expect(byOther).toBeUndefined();
      expect(byHolder).toBeUndefined();
      expect(later).toBeUndefined();
    },
  },
  {
    name: "a finished lease is renewed, yielded and reclaimed no more",
    run: async ({ first }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await first.finish(held);

      expect(await first.renew(held, LEASE)).toBeUndefined();
      expect(await first.yield(held)).toBe(false);
      expect(await first.reclaim(held, LEASE)).toBeUndefined();
    },
  },
  {
    name: "a yielded lease its holder finishes is never taken again",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      expect(await first.yield(held)).toBe(true);

      await first.finish(held);
      await clock.advance(seconds(31));

      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
  {
    name: "a release after the finish leaves it finished",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await first.finish(held);

      await first.release(held);

      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
  {
    name: "finishing a lost lease keeps the new holder's and finishes nothing",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const old = await takenBy(first);
      await clock.advance(seconds(31));
      const taken = await second.acquire("default", "root-1", LEASE);

      await first.finish(old);
      const renewed = taken !== undefined && (await second.renew(taken, LEASE));
      if (taken !== undefined) await second.release(taken);
      const afterRelease = await first.acquire("default", "root-1", LEASE);

      expect(taken).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
      expect(renewed).toBe(LEASE);
      expect(afterRelease).toMatchObject({ holderInstanceId: "instance-1", leaseEpoch: 3 });
    },
  },
  {
    name: "another tenant's tree of the same id is not finished with it",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.finish(await takenBy(first));

      const otherTenant = await second.acquire("acme", "root-1", LEASE);

      expect(otherTenant).toMatchObject({ tenantId: "acme", leaseEpoch: 1 });
    },
  },
  {
    name: "a race of the finish and another instance's acquire while the lease is valid: the acquire is refused either way",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);

      const [, raced] = await Promise.all([
        first.finish(held),
        second.acquire("default", "root-1", LEASE),
      ]);

      expect(raced).toBeUndefined();
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
  {
    name: "a race of the finish and another instance's acquire past the lease: the acquire takes it first (the finish then a no-op) or is refused for good — never both",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await clock.advance(seconds(31));

      const [, raced] = await Promise.all([
        first.finish(held),
        second.acquire("default", "root-1", LEASE),
      ]);
      const renewed = raced !== undefined && (await second.renew(raced, LEASE));
      if (raced !== undefined) await second.release(raced);
      const after = await first.acquire("default", "root-1", LEASE);

      if (raced === undefined) {
        expect(after).toBeUndefined();
      } else {
        expect(raced).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
        expect(renewed).toBe(LEASE);
        expect(after).toMatchObject({ leaseEpoch: 3 });
      }
    },
  },
];
