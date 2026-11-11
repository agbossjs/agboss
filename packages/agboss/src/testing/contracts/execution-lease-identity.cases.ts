import { expect } from "vitest";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";

/**
 * An execution's identity (#591): `claimExecutionId` keeps every id handed out — a root, a
 * child, a recursion level — once, by the id alone, so two trees never share a lease, a fencing
 * token, a audit log or a step key, whatever the application's `IdGenerator` mints. One atomic
 * insert-if-absent across instances; never removed, whatever the id's lease does.
 */

/** What a case gets: the two instances of the lease store. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** A tree's lease for 30 s. */
const LEASE = seconds(30);

/** How many claims of one id each instance sends at once in the race. */
const RACERS = 4;

/** The ids of the exact-comparison case: each its own, none another's. */
const DISTINCT_IDS = ["execution-1", "Execution-1", "execution-10", "execution-", "execution-1 a"];

export const LEASE_IDENTITY_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "#591: a new execution id is kept once — true, then false on either instance",
    run: async ({ first, second }: Instances): Promise<void> => {
      const kept = await first.claimExecutionId({ executionId: "x-1", tenantId: "default" });
      const onSecond = await second.claimExecutionId({
        executionId: "x-1",
        tenantId: "default",
      });
      const again = await first.claimExecutionId({
        executionId: "x-1",
        tenantId: "default",
      });

      expect([kept, onSecond, again]).toEqual([true, false, false]);
    },
  },
  {
    name: "#591: an id is one across tenants — kept for one, refused for another (step keys carry no tenant)",
    run: async ({ first, second }: Instances): Promise<void> => {
      const acme = await first.claimExecutionId({ executionId: "x-1", tenantId: "acme" });
      const other = await second.claimExecutionId({
        executionId: "x-1",
        tenantId: "globex",
      });
      const own = await second.claimExecutionId({ executionId: "x-2", tenantId: "globex" });

      expect([acme, other, own]).toEqual([true, false, true]);
    },
  },
  {
    name: `#591: ${String(RACERS * 2)} concurrent claims of one id on both instances — exactly one is true`,
    run: async ({ first, second }: Instances): Promise<void> => {
      const identity = { executionId: "x-race", tenantId: "default" };
      const claims = Array.from({ length: RACERS }, () => [
        first.claimExecutionId(identity),
        second.claimExecutionId(identity),
      ]).flat();

      const answers = await Promise.all(claims);

      expect(answers.filter((answer) => answer)).toHaveLength(1);
      expect(await first.claimExecutionId(identity)).toBe(false);
    },
  },
  {
    name: "#591: ids are compared exactly — a case, a prefix or a suffix is another id",
    run: async ({ first, second }: Instances): Promise<void> => {
      const kept = await Promise.all(
        DISTINCT_IDS.map((executionId, at) =>
          (at % 2 === 0 ? first : second).claimExecutionId({
            executionId,
            tenantId: "default",
          }),
        ),
      );
      const repeated = await Promise.all(
        DISTINCT_IDS.map((executionId) =>
          second.claimExecutionId({ executionId, tenantId: "default" }),
        ),
      );

      expect(kept).toEqual(DISTINCT_IDS.map(() => true));
      expect(repeated).toEqual(DISTINCT_IDS.map(() => false));
    },
  },
  {
    name: "#591: a kept id's tree takes its lease as before, and the id stays kept once the lease is released or finished",
    run: async ({ first, second }: Instances): Promise<void> => {
      const identity = { executionId: "root-1", tenantId: "default" };
      await first.claimExecutionId(identity);
      const held = await first.acquire("default", "root-1", LEASE);
      if (held !== undefined) await first.release(held);
      const afterRelease = await second.claimExecutionId(identity);
      const again = await second.acquire("default", "root-1", LEASE);
      if (again !== undefined) await second.retire(again);
      const afterFinish = await first.claimExecutionId(identity);

      expect(held).toMatchObject({ rootExecutionId: "root-1", token: 1 });
      expect(again).toMatchObject({ holderInstanceId: "instance-2", token: 2 });
      expect([afterRelease, afterFinish]).toEqual([false, false]);
    },
  },
];
