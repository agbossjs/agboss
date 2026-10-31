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

/** The lease of `rootExecutionId` taken by `store` (a free key's first acquire must take it). */
async function takenBy(store: ExecutionLeaseRepository): Promise<ExecutionLease> {
  const held = await store.acquire("default", "root-1", LEASE);
  if (held === undefined) throw new Error("the first acquire of a free tree must take its lease");
  return held;
}

/** `held` is still its holder's: renewed, and refused to `other` — then given back. */
async function expectStillHeld(
  holder: ExecutionLeaseRepository,
  other: ExecutionLeaseRepository,
  held: ExecutionLease,
): Promise<void> {
  expect(await holder.renew(held, LEASE)).toBe(true);
  expect(await other.acquire("default", held.rootExecutionId, LEASE)).toBeUndefined();
  await holder.release(held);
}

/**
 * A finished lease at its edges (#520, acceptance): a finish matches the lease as `release` does —
 * its holder **and** its epoch — so a finish with an epoch a release, a new take or a reclaim moved
 * on, and a finish of another holder's lease or of a key nobody took, finishes nothing; a
 * finished key is refused to every instance at once and after any time.
 */
export const LEASE_FINISH_EDGE_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "#520: a finish with the epoch before its holder's release and new take finishes nothing — the newer lease stays held, then free",
    run: async ({ first, second }: Instances): Promise<void> => {
      const old = await takenBy(first);
      await first.release(old);
      const newer = await takenBy(first);

      await first.finish(old);

      await expectStillHeld(first, second, newer);
      expect(await second.acquire("default", "root-1", LEASE)).toMatchObject({ leaseEpoch: 3 });
    },
  },
  {
    name: "#520: a finish with the epoch before a reclaim finishes nothing — the reclaimed lease stays held, then free",
    run: async ({ first, second }: Instances): Promise<void> => {
      const yielded = await takenBy(first);
      expect(await first.yield(yielded)).toBe(true);
      const reclaimed = await first.reclaim(yielded, LEASE);
      if (reclaimed === undefined) throw new Error("the holder's reclaim must take its lease back");

      await first.finish(yielded);

      await expectStillHeld(first, second, reclaimed);
      expect(await second.acquire("default", "root-1", LEASE)).toMatchObject({ leaseEpoch: 3 });
    },
  },
  {
    name: "#520: released, taken by another instance, then the old holder's finish: the new holder's lease is kept, and the key is not finished",
    run: async ({ first, second }: Instances): Promise<void> => {
      const old = await takenBy(first);
      await first.release(old);
      const taken = await takenBy(second);

      await first.finish(old);

      await expectStillHeld(second, first, taken);
      expect(await first.acquire("default", "root-1", LEASE)).toMatchObject({
        holderInstanceId: "instance-1",
        leaseEpoch: 3,
      });
    },
  },
  {
    name: "#520: a finish of a key nobody took finishes nothing: its first acquire takes it",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const never: ExecutionLease = {
        tenantId: "default",
        rootExecutionId: "root-9",
        holderInstanceId: "instance-1",
        leaseEpoch: 1,
        expiresAt: new Date(clock.now().getTime() + LEASE),
      };

      await first.finish(never);

      expect(await second.acquire("default", "root-9", LEASE)).toMatchObject({
        holderInstanceId: "instance-2",
        leaseEpoch: 1,
      });
    },
  },
  {
    name: "#520: a finished key stays finished for every instance, after any time, and a second finish changes nothing",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await first.finish(held);
      await first.finish(held);

      await clock.advance(seconds(3600));
      const attempts = await Promise.all([
        first.acquire("default", "root-1", LEASE),
        second.acquire("default", "root-1", LEASE),
        second.acquire("default", "root-1", LEASE),
      ]);

      expect(attempts).toEqual([undefined, undefined, undefined]);
      expect(await first.renew(held, LEASE)).toBe(false);
    },
  },
];
