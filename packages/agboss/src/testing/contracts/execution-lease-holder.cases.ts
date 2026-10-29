import { expect } from "vitest";
import { executionLeasesOf } from "../../app/execution-leases.js";
import { ExecutionLeaseLostError } from "../../app/lease-lost.js";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { ExecutionTree } from "../../infrastructure/execution-tree.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** The tree of the leases below: the tenant `"default"`, one root. */
const ROOT_1: ExecutionTree = { tenantId: "default", rootExecutionId: "root-1" };

/**
 * The framework's holder of a tree's lease (`executionLeasesOf`) over the store: what a store
 * does not see directly, but must make true — a frozen holder loses the lease, a live one keeps it,
 * a release wakes the waiting instance.
 */
export const LEASE_HOLDER_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "a holder frozen past the lease loses it to the waiting instance: its signal aborts",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const holder = await executionLeasesOf(first, clock).hold(ROOT_1);
      const waiting = executionLeasesOf(second, clock).hold(ROOT_1);

      await clock.advance(seconds(31));
      const taken = await waiting;

      expect(holder.signal.aborted).toBe(true);
      expect(holder.signal.reason).toBeInstanceOf(ExecutionLeaseLostError);
      await expect(holder.renewNow()).rejects.toBeInstanceOf(ExecutionLeaseLostError);
      expect(taken.signal.aborted).toBe(false);
      await taken.release();
      await holder.release();
    },
  },
  {
    name: "a live holder renews every third of the lease: the waiting call waits",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const holder = await executionLeasesOf(first, clock).hold(ROOT_1);
      let isTaken = false;
      const waiting = executionLeasesOf(second, clock)
        .hold(ROOT_1)
        .then((lease) => {
          isTaken = true;
          return lease;
        });

      for (let step = 0; step < 9; step += 1) await clock.advance(seconds(10));

      expect(isTaken).toBe(false);
      expect(holder.signal.aborted).toBe(false);
      await holder.release();
      await (await waiting).release();
      expect(isTaken).toBe(true);
    },
  },
  {
    name: "a release wakes the waiting call at once, without the clock",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const holder = await executionLeasesOf(first, clock).hold(ROOT_1);
      const waiting = executionLeasesOf(second, clock).hold(ROOT_1);

      await holder.release();
      const taken = await waiting;

      expect(taken.signal.aborted).toBe(false);
      await taken.release();
    },
  },
  {
    name: "the caller's signal ends the wait with its reason",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const holder = await executionLeasesOf(first, clock).hold(ROOT_1);
      const cancelled = new AbortController();
      const waiting = executionLeasesOf(second, clock).hold(ROOT_1, cancelled.signal);

      cancelled.abort(new Error("the caller gave up"));

      await expect(waiting).rejects.toThrow("the caller gave up");
      await holder.release();
    },
  },
];
