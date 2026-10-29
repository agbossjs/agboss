/**
 * #471 — the held lease at its edges: `confirmNow()` while yielded, a wait that ends in a hand-over
 * or in an ordinary failure, `release()` after the lease was lost, while yielded and twice, and a
 * step's leave called twice. Against the in-memory and the SQLite lease store, the lease timers on a
 * gate the test holds closed.
 */
import { describe, expect, it } from "vitest";
import { executionLeasesOf, type HeldExecutionLease } from "../../src/app/execution-leases.js";
import { handedOverOf } from "../../src/app/handed-over.js";
import {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  type ExecutionLease,
  type ExecutionLeaseRepository,
} from "../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { LeaseGate } from "../../src/testing/leases.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { storeTargets } from "../infrastructure/contracts/store-kinds.js";
import { withTarget } from "../../src/testing/contracts/seam.js";

const kinds = storeTargets<ExecutionLeaseRepository>(
  ({ clock, application, database }) =>
    new InMemoryExecutionLeaseRepository(clock, application, database),
  ({ clock, application, connection }) =>
    new SqliteExecutionLeaseRepository(connection(), clock, application),
);

const TREE = { tenantId: "acme", rootExecutionId: "root-1" };

/** The store, counting the releases that reach it. */
function countingReleases(store: ExecutionLeaseRepository): {
  readonly store: ExecutionLeaseRepository;
  readonly released: ExecutionLease[];
} {
  const released: ExecutionLease[] = [];
  const counted = Object.assign(Object.create(store) as ExecutionLeaseRepository, {
    release: (lease: ExecutionLease): Promise<void> => {
      released.push(lease);
      return store.release(lease);
    },
  });
  return { store: counted, released };
}

async function heldOn(
  store: ExecutionLeaseRepository,
  clock: VirtualClock,
): Promise<HeldExecutionLease> {
  const gate = new LeaseGate();
  gate.close();
  return executionLeasesOf(store, gate.clockOf(clock)).hold(TREE);
}

const settled = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A wait the test ends: `end(error?)` resolves it, or rejects it with `error`. */
function heldWait(): { readonly wait: () => Promise<void>; end: (error?: Error) => void } {
  const handle = { end: (_error?: Error): void => undefined };
  const wait = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      handle.end = (error) => {
        if (error === undefined) resolve();
        else reject(error);
      };
    });
  return {
    wait,
    end: (error) => {
      handle.end(error);
    },
  };
}

const acquireBy = (store: ExecutionLeaseRepository) =>
  store.acquire(TREE.tenantId, TREE.rootExecutionId, seconds(30));

describe.each(kinds)("#471: the held lease at its edges ($name)", (target) => {
  it(
    "confirmNow() while the lease is yielded rejects: lost, nothing renewed",
    withTarget(target, async ({ clock, first }) => {
      const lease = await heldOn(first, clock);
      const { wait, end } = heldWait();
      const waiting = lease.yieldWhile(wait);
      waiting.catch(() => undefined);
      await settled();
      expect(lease.isYielded).toBe(true);

      await expect(lease.confirmNow()).rejects.toThrow(ExecutionLeaseLostError);

      expect(lease.signal.aborted).toBe(true);
      end();
      await expect(waiting).resolves.toBeUndefined();
      await lease.release();
    }),
  );

  it(
    "a wait that ends in a hand-over rises as it is; the lease is not taken back",
    withTarget(target, async ({ clock, first, second }) => {
      const lease = await heldOn(first, clock);
      const { wait, end } = heldWait();
      const waiting = lease.yieldWhile(wait);
      waiting.catch(() => undefined);
      await settled();
      const handedOver = new ExecutionLeaseLostError(TREE.rootExecutionId);

      end(handedOver);

      await expect(waiting).rejects.toBe(handedOver);
      expect(lease.token).toBeUndefined();
      expect((await acquireBy(second))?.leaseEpoch).toBe(2);
      await lease.release();
    }),
  );

  it(
    "a wait that fails otherwise takes the lease back, then rises",
    withTarget(target, async ({ clock, first, second }) => {
      const lease = await heldOn(first, clock);
      const { wait, end } = heldWait();
      const waiting = lease.yieldWhile(wait);
      waiting.catch(() => undefined);
      await settled();
      const failure = new Error("the remote child failed");

      end(failure);

      await expect(waiting).rejects.toBe(failure);
      expect(lease.token).toBe(2);
      expect(lease.isYielded).toBe(false);
      expect(await acquireBy(second)).toBeUndefined();
      await lease.release();
    }),
  );

  it(
    "release() after a fenced write leaves the store alone: the lease runs out there",
    withTarget(target, async ({ clock, first, second }) => {
      const { store, released } = countingReleases(first);
      const lease = await heldOn(store, clock);
      // a fenced write found anywhere stops the holder of its token (#471)
      handedOverOf(
        new ExecutionFencedError({ scopeKey: lease.scopeKey, token: 1, observedToken: 2 }),
        undefined,
      );
      expect(lease.signal.aborted).toBe(true);

      await lease.release();

      expect(released).toEqual([]);
      expect(await acquireBy(second)).toBeUndefined();
      expect(lease.isYielded).toBe(false);
    }),
  );

  it(
    "release() while yielded and release() twice give the store nothing more",
    withTarget(target, async ({ clock, first }) => {
      const { store, released } = countingReleases(first);
      const lease = await heldOn(store, clock);
      const { wait, end } = heldWait();
      const waiting = lease.yieldWhile(wait);
      waiting.catch(() => undefined);
      await settled();
      expect(released).toHaveLength(1);

      await lease.release();
      await lease.release();

      expect(released).toHaveLength(1);
      end();
      await waiting;
    }),
  );

  it(
    "a step's leave called twice counts once: the other step still keeps the lease",
    withTarget(target, async ({ clock, first, second }) => {
      const lease = await heldOn(first, clock);
      const leaveOne = await lease.enterStep();
      const leaveOther = await lease.enterStep();
      leaveOne();
      leaveOne();
      const { wait, end } = heldWait();
      const waiting = lease.yieldWhile(wait);
      await settled();

      expect(lease.isYielded).toBe(false);
      expect(await acquireBy(second)).toBeUndefined();

      leaveOther();
      await settled();
      expect(lease.isYielded).toBe(true);
      end();
      await waiting;
      await lease.release();
    }),
  );
});
