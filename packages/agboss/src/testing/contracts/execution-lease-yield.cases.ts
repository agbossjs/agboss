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
 * A yielded lease (#516): its holder waits for children on any instance, and the lease stays its
 * own in the store — another `acquire` is refused while it is valid, `renew` keeps it, the holder
 * takes it back with `reclaim` at the next `leaseEpoch` (matched as `renew` matches it); only once
 * it expired another instance takes it over, naming the holder.
 */
export const LEASE_YIELD_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "a yielded lease blocks another acquire until it expires",
    run: async ({ clock, second, first }: Instances): Promise<void> => {
      await yieldedBy(first);

      const refused = await second.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(29));
      const stillRefused = await second.acquire("default", "root-1", LEASE);

      expect(refused).toBeUndefined();
      expect(stillRefused).toBeUndefined();
    },
  },
  {
    name: "a renewal keeps a yielded lease past its first expiry, still yielded",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);

      await clock.advance(seconds(20));
      const renewed = await first.renew(held, LEASE);
      await clock.advance(seconds(20));
      const refused = await second.acquire("default", "root-1", LEASE);
      const reclaimed = await first.reclaim(held, LEASE);

      expect(renewed).toBe(LEASE);
      expect(refused).toBeUndefined();
      expect(reclaimed).toMatchObject({ holderInstanceId: "instance-1", leaseEpoch: 2 });
    },
  },
  {
    name: "the holder reclaims its yielded lease at leaseEpoch + 1: held again, the old epoch's renew false",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);
      await clock.advance(seconds(5));

      const reclaimed = await first.reclaim(held, LEASE);

      expect(reclaimed).toMatchObject({
        tenantId: "default",
        rootExecutionId: "root-1",
        holderInstanceId: "instance-1",
        leaseEpoch: 2,
        expiresAt: new Date("2026-01-05T09:00:35.000Z"),
        remaining: LEASE,
      });
      expect(reclaimed?.takenOverFrom).toBeUndefined();
      expect(await first.renew(held, LEASE)).toBeUndefined();
      expect(reclaimed && (await first.renew(reclaimed, LEASE))).toBe(LEASE);
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
  {
    name: "a held lease is reclaimed too: the holder that never yielded moves to leaseEpoch + 1",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await first.acquire("default", "root-1", LEASE);

      const reclaimed = held && (await first.reclaim(held, LEASE));

      expect(reclaimed).toMatchObject({ holderInstanceId: "instance-1", leaseEpoch: 2 });
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
  {
    name: "an expired yielded lease is taken over with takenOverFrom; the old holder's reclaim, renew and yield then fail",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);
      await clock.advance(seconds(31));

      const taken = await second.acquire("default", "root-1", LEASE);

      expect(taken).toMatchObject({
        holderInstanceId: "instance-2",
        leaseEpoch: 2,
        takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
      });
      expect(await first.reclaim(held, LEASE)).toBeUndefined();
      expect(await first.renew(held, LEASE)).toBeUndefined();
      expect(await first.yield(held)).toBe(false);
      expect(taken && (await second.renew(taken, LEASE))).toBe(LEASE);
    },
  },
  {
    name: "a reclaim racing a takeover attempt: the holder wins while its lease is valid",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);

      const [taken, reclaimed] = await Promise.all([
        second.acquire("default", "root-1", LEASE),
        first.reclaim(held, LEASE),
      ]);

      expect(taken).toBeUndefined();
      expect(reclaimed).toMatchObject({ holderInstanceId: "instance-1", leaseEpoch: 2 });
    },
  },
  {
    name: "a yielded lease its holder releases is free at once, with no previous holder",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await yieldedBy(first);

      await first.release(held);
      const next = await second.acquire("default", "root-1", LEASE);

      expect(next).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
      expect(next?.takenOverFrom).toBeUndefined();
      expect(await first.reclaim(held, LEASE)).toBeUndefined();
    },
  },
  {
    name: "only the holder's own lease yields: another instance's, a released one and another tenant's tree do not",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await first.acquire("default", "root-1", LEASE);
      const foreign = held && { ...held, holderInstanceId: "instance-2" };
      const otherTenant = held && { ...held, tenantId: "acme" };

      const byOther = foreign && (await second.yield(foreign));
      const ofOtherTenant = otherTenant && (await first.yield(otherTenant));
      if (held !== undefined) await first.release(held);
      const released = held && (await first.yield(held));

      expect(byOther).toBe(false);
      expect(ofOtherTenant).toBe(false);
      expect(released).toBe(false);
      expect(await second.acquire("default", "root-1", LEASE)).toMatchObject({ leaseEpoch: 2 });
    },
  },
];
