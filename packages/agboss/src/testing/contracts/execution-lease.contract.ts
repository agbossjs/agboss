import { expect } from "vitest";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import { seconds } from "../../units/index.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { LEASE_CONFIRM_CASES } from "./execution-lease-confirm.cases.js";
import { LEASE_EXPIRY_RACE_CASES } from "./execution-lease-expiry-races.cases.js";
import { LEASE_EXPIRY_CASES } from "./execution-lease-expiry.cases.js";
import { LEASE_FINISH_EDGE_CASES } from "./execution-lease-finish-edges.cases.js";
import { LEASE_FINISH_HOLDER_CASES } from "./execution-lease-finish-holder.cases.js";
import { LEASE_FINISH_CASES } from "./execution-lease-finish.cases.js";
import { LEASE_HOLDER_CASES } from "./execution-lease-holder.cases.js";
import { LEASE_YIELD_EDGE_CASES } from "./execution-lease-yield-edges.cases.js";
import { LEASE_YIELD_CASES } from "./execution-lease-yield.cases.js";
import type { ContractTarget } from "./seam.js";

/** A tree's lease for 30 s. */
const LEASE = seconds(30);

const LEASE_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "a tree's lease held by one instance is not given to the other",
    run: async ({ first, second }) => {
      const held = await first.acquire("default", "root-1", LEASE);
      const refused = await second.acquire("default", "root-1", LEASE);

      expect(held).toMatchObject({
        tenantId: "default",
        rootExecutionId: "root-1",
        holderInstanceId: "instance-1",
        leaseEpoch: 1,
        expiresAt: new Date("2026-01-05T09:00:30.000Z"),
      });
      expect(refused).toBeUndefined();
    },
  },
  {
    name: "past the lease the other takes it with leaseEpoch + 1, and the old holder's renew is false",
    run: async ({ clock, first, second }) => {
      const old = await first.acquire("default", "root-1", LEASE);

      await clock.advance(seconds(31));
      const taken = await second.acquire("default", "root-1", LEASE);

      expect(taken).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
      expect(old && (await first.renew(old, LEASE))).toBe(false);
      expect(taken && (await second.renew(taken, LEASE))).toBe(true);
    },
  },
  {
    name: "a released lease is taken at once with leaseEpoch + 1; another tenant's tree is its own",
    run: async ({ first, second }) => {
      const held = await first.acquire("default", "root-1", LEASE);
      if (held !== undefined) await first.release(held);

      const next = await second.acquire("default", "root-1", LEASE);
      const otherTenant = await second.acquire("acme", "root-1", LEASE);

      expect(next).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
      expect(otherTenant).toMatchObject({ tenantId: "acme", leaseEpoch: 1 });
    },
  },
  {
    name: "acquire after expiry reports the previous holder; after release it does not",
    run: async ({ clock, first, second }) => {
      const fresh = await first.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(31));
      const taken = await second.acquire("default", "root-1", LEASE);
      if (taken !== undefined) await second.release(taken);
      const afterRelease = await first.acquire("default", "root-1", LEASE);

      expect(fresh?.takenOverFrom).toBeUndefined();
      expect(taken).toMatchObject({
        leaseEpoch: 2,
        takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
      });
      expect(afterRelease).toMatchObject({ leaseEpoch: 3 });
      expect(afterRelease?.takenOverFrom).toBeUndefined();
    },
  },
  {
    name: "a holder that takes its own expired lease back reports itself as the previous holder",
    run: async ({ clock, first }) => {
      await first.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(31));

      const again = await first.acquire("default", "root-1", LEASE);

      expect(again?.takenOverFrom).toEqual({ holderInstanceId: "instance-1", leaseEpoch: 1 });
    },
  },
  {
    name: "releasing a lost lease leaves the new holder's",
    run: async ({ clock, first, second }) => {
      const old = await first.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(31));
      const taken = await second.acquire("default", "root-1", LEASE);

      if (old !== undefined) await first.release(old);

      expect(taken && (await second.renew(taken, LEASE))).toBe(true);
      expect(await first.acquire("default", "root-1", LEASE)).toBeUndefined();
    },
  },
];

/**
 * `ExecutionLeaseRepository` (#265 AC11, Q58): one lease per tree, keyed by `(tenantId,
 * rootExecutionId)` — not given to another instance while valid (`expiresAt > now`), taken with
 * `leaseEpoch + 1` after it expired or was released, the old holder's `renew` then `false`; at
 * `now >= expiresAt` the lease is over for its holder too (#534: `renew`, `yield`, `reclaim` and the
 * holder's `confirmNow()` refused, taken or not) — a take after expiry names the
 * expired holder (`takenOverFrom`, #501), one after a release none —; a yielded lease (#516) still
 * its holder's, renewed and refused to others until it expires, taken back with `reclaim`; a finished
 * lease (#520) never taken again, so no stale instance takes over finished work; and the
 * framework's holder over it — it aborts its work when the lease is lost, renews while alive (also
 * while it waits for remote children), and a release wakes the waiting instance.
 */
export function executionLeaseContract(target: ContractTarget<ExecutionLeaseRepository>): void {
  registerContract(
    "lease contract",
    target,
    [
      { cases: LEASE_CASES },
      { title: "a yielded lease", cases: [...LEASE_YIELD_CASES, ...LEASE_YIELD_EDGE_CASES] },
      {
        title: "the lease's expiry, for its holder too",
        cases: [...LEASE_EXPIRY_CASES, ...LEASE_EXPIRY_RACE_CASES],
      },
      { title: "a finished lease", cases: [...LEASE_FINISH_CASES, ...LEASE_FINISH_EDGE_CASES] },
      { title: "the framework's holder of a tree's lease", cases: LEASE_HOLDER_CASES },
      { title: "the framework's holder at the lease's expiry", cases: LEASE_CONFIRM_CASES },
      { title: "the framework's take of finished work", cases: LEASE_FINISH_HOLDER_CASES },
    ],
    pingOf,
  );
}
