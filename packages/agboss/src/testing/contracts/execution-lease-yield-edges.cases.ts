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

/** The lease of `root-1` taken by the first instance and yielded at once. */
async function yieldedBy(store: ExecutionLeaseRepository): Promise<ExecutionLease> {
  const held = await store.acquire("default", "root-1", LEASE);
  if (held === undefined) throw new Error("the first acquire of a free tree must take its lease");
  expect(await store.yield(held)).toBe(true);
  return held;
}

/**
 * A yielded lease at its edges (#516, acceptance): 1 ms before its expiry it still blocks; once
 * expired, a reclaim racing another instance's take leaves exactly one holder — never two, never
 * none; a yield said twice is one yield; after a reclaim the old epoch is stale for every call.
 */
export const LEASE_YIELD_EDGE_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "a yielded lease 1 ms before its expiry still blocks another acquire",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      await yieldedBy(first);

      await clock.advance(seconds(29.999));

      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
  {
    name: "an expired yielded lease, reclaimed and taken at once: exactly one instance holds it",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);
      await clock.advance(seconds(30.001));

      const [taken, reclaimed] = await Promise.all([
        second.acquire("default", "root-1", LEASE),
        first.reclaim(held, LEASE),
      ]);

      const holders = [taken, reclaimed].filter((lease) => lease !== undefined);
      expect(holders).toHaveLength(1);
      const [holder] = holders;
      const owner = holder?.holderInstanceId === "instance-1" ? first : second;
      const other = owner === first ? second : first;
      expect(holder && (await owner.renew(holder, LEASE))).toBe(LEASE);
      expect(
        holder && (await other.renew({ ...holder, holderInstanceId: "x" }, LEASE)),
      ).toBeUndefined();
    },
  },
  {
    name: "a lease yielded twice is one yielded lease: both answer true, another acquire is refused",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);

      const again = await first.yield(held);

      expect(again).toBe(true);
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
      expect(await first.reclaim(held, LEASE)).toMatchObject({ leaseEpoch: 2 });
    },
  },
  {
    name: "after a reclaim the old epoch is stale: its yield, reclaim and renew are refused",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);
      const reclaimed = await first.reclaim(held, LEASE);

      expect(await first.yield(held)).toBe(false);
      expect(await first.reclaim(held, LEASE)).toBeUndefined();
      expect(await first.renew(held, LEASE)).toBeUndefined();
      expect(reclaimed && (await first.renew(reclaimed, LEASE))).toBe(LEASE);
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
];
