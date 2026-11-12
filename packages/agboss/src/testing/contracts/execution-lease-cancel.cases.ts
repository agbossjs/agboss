import { expect } from "vitest";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** A tree's lease for 30 s. */
const LEASE = seconds(30);

/** The tree of the cases: `root-1` of the default tenant. */
const TREE = { tenantId: "default", rootExecutionId: "root-1" } as const;

/** The lease of `root-1` taken by `store`: the first acquire of a free key must take it. */
async function takenBy(store: ExecutionLeaseRepository): Promise<ExecutionLease> {
  const held = await store.acquire("default", "root-1", LEASE);
  if (held === undefined) throw new Error("the first acquire of a free tree must take its lease");
  return held;
}

/**
 * The cancel mark of a tree (#909, `requestCancel`): durable once it resolves, idempotent, and no
 * lease operation — the holder keeps its lease, renews it and releases it, a free lease is taken as
 * before, a tree with no lease yet is marked. What the mark fences is the fencing stores' contract
 * (`fencedEffectContract`, `outboundCallContract`); a coordination store that keeps no fencing
 * stores (Redis) passes these cases by resolving and writing nothing.
 */
export const LEASE_CANCEL_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "#909 AC1: requestCancel changes no lease — the holder renews and releases it, the next take is token + 1, another instance is still refused while it is held",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);

      await second.requestCancel(TREE);

      expect(await first.renew(held, LEASE)).toBe(LEASE);
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
      await first.release(held);
      expect(await second.acquire("default", "root-1", LEASE)).toMatchObject({ token: 2 });
    },
  },
  {
    name: "#909 AC1: requestCancel of a tree with no lease yet resolves, and its first acquire is token 1 — the mark is no lease",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.requestCancel(TREE);

      expect(await second.acquire("default", "root-1", LEASE)).toMatchObject({
        token: 1,
        holderInstanceId: "instance-2",
      });
    },
  },
  {
    name: "#909 AC1: requestCancel twice, from both instances, resolves each time — idempotent — and a yielded lease stays yielded and reclaimable",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      expect(await first.yield(held)).toBeDefined();

      await first.requestCancel(TREE);
      await second.requestCancel(TREE);
      await first.requestCancel(TREE);

      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
      expect(await first.reclaim(held, LEASE)).toMatchObject({ token: 2 });
    },
  },
  {
    name: "#909: a free lease of a cancelled tree is acquired as before, and expires and is taken over as before",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await first.release(held);
      await first.requestCancel(TREE);

      const next = await second.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(31));
      const taken = await first.acquire("default", "root-1", LEASE);

      expect(next).toMatchObject({ token: 2 });
      expect(taken).toMatchObject({
        token: 3,
        takenOverFrom: { holderInstanceId: "instance-2", token: 2 },
      });
    },
  },
  {
    name: "#909: a cancel of another tree or another tenant's tree takes nothing from this one",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.requestCancel({ tenantId: "default", rootExecutionId: "root-2" });
      await first.requestCancel({ tenantId: "acme", rootExecutionId: "root-1" });

      const held = await takenBy(first);

      expect(await first.renew(held, LEASE)).toBe(LEASE);
      expect(await second.acquire("acme", "root-1", LEASE)).toMatchObject({ token: 1 });
    },
  },
];
