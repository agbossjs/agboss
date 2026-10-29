/**
 * #471 — the held lease as `executionContext.fence` reads it: its token and scope, `assertHeld()`
 * (local, no I/O; past `confirmedUntil` it expires the lease first), `confirmNow()` (a strict
 * renewal: confirmed → the after-renewal checks, anything else → lost), a fenced write stopping the
 * holder of its token, and the `yieldWhile` rule — the lease is yielded only while no other step of
 * the tree runs. Run against the in-memory and the SQLite lease store; the lease timers on a gated
 * clock (`LeaseGate`, what `leases.stall` uses), so `confirmedUntil` can pass without them.
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
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { storeKinds } from "../infrastructure/contracts/store-kinds.js";

const kinds = storeKinds<ExecutionLeaseRepository>({
  inMemory: ({ clock, application, database }) =>
    new InMemoryExecutionLeaseRepository(clock, application, database),
  sqlite: ({ clock, application, connection }) =>
    new SqliteExecutionLeaseRepository(connection(), clock, application),
});

const TREE = { tenantId: "acme:eu", rootExecutionId: "root:1" };

/** A store whose `renew` the test can make fail (a store that does not answer). */
class FlakyLeases {
  isDown = false;
  renewals = 0;

  constructor(readonly store: ExecutionLeaseRepository) {}

  wrap(): ExecutionLeaseRepository {
    const flaky = this.store;
    return Object.assign(Object.create(flaky) as ExecutionLeaseRepository, {
      renew: (lease: ExecutionLease, length: Milliseconds): Promise<boolean> => {
        this.renewals += 1;
        return this.isDown ? Promise.reject(new Error("store down")) : flaky.renew(lease, length);
      },
    });
  }
}

/** The tree's lease on `store`, its timers on a gate the test holds closed (they never fire). */
async function heldOn(
  store: ExecutionLeaseRepository,
  clock: VirtualClock,
): Promise<{ readonly lease: HeldExecutionLease; readonly gate: LeaseGate }> {
  const gate = new LeaseGate();
  gate.close();
  const lease = await executionLeasesOf(store, gate.clockOf(clock)).hold(TREE);
  return { lease, gate };
}

describe.each(kinds)("#471: the held lease's fence ($name)", ({ twoInstances }) => {
  it("names its scope — each part encoded, one ':' — its tenant, execution and token 1", async () => {
    const { clock, first } = twoInstances();
    const { lease } = await heldOn(first, clock);

    expect(lease.scopeKey).toBe("acme%3Aeu:root%3A1");
    expect(lease.tenantId).toBe("acme:eu");
    expect(lease.leaseExecutionId).toBe("root:1");
    expect(lease.token).toBe(1);
    expect(lease.isYielded).toBe(false);
    expect(lease.confirmedUntil).toBe(clock.now().getTime() + seconds(30));
    await lease.release();
  });

  it("assertHeld() passes before confirmedUntil and, at it, expires the lease first, then throws", async () => {
    const { clock, first } = twoInstances();
    const { lease } = await heldOn(first, clock);

    await clock.advance(seconds(29));
    expect(() => {
      lease.assertHeld();
    }).not.toThrow();
    expect(lease.signal.aborted).toBe(false);
    await clock.advance(seconds(1));

    expect(() => {
      lease.assertHeld();
    }).toThrow(ExecutionLeaseLostError);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBeInstanceOf(ExecutionLeaseLostError);
    await lease.release();
  });

  it("confirmNow() renews in the store, moves confirmedUntil on and runs the after-renewal checks", async () => {
    const { clock, first } = twoInstances();
    const { lease } = await heldOn(first, clock);
    const checks: string[] = [];
    lease.afterEachRenewal(() => {
      checks.push("cancel looked for");
      return Promise.resolve();
    });

    await clock.advance(seconds(20));
    await lease.confirmNow();

    expect(checks).toEqual(["cancel looked for"]);
    expect(lease.confirmedUntil).toBe(clock.now().getTime() + seconds(30));
    await clock.advance(seconds(20));
    expect(() => {
      lease.assertHeld();
    }).not.toThrow();
    await lease.release();
  });

  it("confirmNow() on a transient store error aborts the lease and rejects: a hand-over, no check runs", async () => {
    const { clock, first } = twoInstances();
    const flaky = new FlakyLeases(first);
    const { lease } = await heldOn(flaky.wrap(), clock);
    const checks: string[] = [];
    lease.afterEachRenewal(() => {
      checks.push("checked");
      return Promise.resolve();
    });
    flaky.isDown = true;

    await expect(lease.confirmNow()).rejects.toThrow(ExecutionLeaseLostError);

    expect(lease.signal.aborted).toBe(true);
    expect(checks).toEqual([]);
    expect(flaky.renewals).toBe(1);
    await lease.release();
  });

  it("confirmNow() after another instance took the lease rejects: lost", async () => {
    const { clock, first, second } = twoInstances();
    const { lease } = await heldOn(first, clock);
    await clock.advance(seconds(31));
    const other = await executionLeasesOf(second, clock).hold(TREE);

    await expect(lease.confirmNow()).rejects.toThrow(ExecutionLeaseLostError);

    expect(other.token).toBe(2);
    await other.release();
    await lease.release();
  });

  it("a fenced write of its token stops the holder with the fenced error; one of another token does not", async () => {
    const { clock, first, second } = twoInstances();
    const { lease } = await heldOn(first, clock);
    await clock.advance(seconds(31));
    const other = await executionLeasesOf(second, clock).hold(TREE);

    const refusedNew = new ExecutionFencedError({
      scopeKey: other.scopeKey,
      token: 3,
      observedToken: 4,
    });
    handedOverOf(refusedNew, undefined);
    expect(lease.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);

    const refused = new ExecutionFencedError({
      scopeKey: lease.scopeKey,
      token: 1,
      observedToken: 2,
    });
    const found = handedOverOf(new Error("the driver failed", { cause: refused }), undefined);

    expect(found).toBe(refused);
    expect(lease.signal.reason).toBe(refused);
    expect(other.signal.aborted).toBe(false);
    await other.release();
    await lease.release();
  });
});

describe.each(kinds)(
  "#471 / #333: yieldWhile yields only while no other step runs ($name)",
  ({ twoInstances }) => {
    it("a sibling step running keeps the lease in the store; once it leaves, the lease is yielded", async () => {
      const { clock, first, second } = twoInstances();
      const { lease } = await heldOn(first, clock);
      const leave = await lease.enterStep();
      let release = (): void => undefined;
      const waiting = lease.yieldWhile(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();

      // the sibling still runs: nobody else gets the lease, the step's fence keeps its token
      expect(
        await second.acquire(TREE.tenantId, TREE.rootExecutionId, seconds(30)),
      ).toBeUndefined();
      expect(lease.token).toBe(1);
      expect(lease.isYielded).toBe(false);

      leave();
      for (let tick = 0; tick < 20; tick += 1)
        await new Promise((resolve) => setImmediate(resolve));
      expect(lease.isYielded).toBe(true);
      expect(lease.token).toBeUndefined();

      release();
      await waiting;
      expect(lease.isYielded).toBe(false);
      expect(lease.token).toBe(2);
      await lease.release();
    });

    it("a step that starts while the lease is yielded takes it back first, under a new token", async () => {
      const { clock, first, second } = twoInstances();
      const { lease } = await heldOn(first, clock);
      let release = (): void => undefined;
      const waiting = lease.yieldWhile(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      for (let tick = 0; tick < 20; tick += 1)
        await new Promise((resolve) => setImmediate(resolve));
      expect(lease.isYielded).toBe(true);

      const leave = await lease.enterStep();

      expect(lease.isYielded).toBe(false);
      expect(lease.token).toBe(2);
      expect(
        await second.acquire(TREE.tenantId, TREE.rootExecutionId, seconds(30)),
      ).toBeUndefined();
      leave();
      release();
      await waiting;
      expect(lease.isYielded).toBe(false);
      await lease.release();
    });

    it("a step that cannot take the lease back (another holds it) is handed over", async () => {
      const { clock, first, second } = twoInstances();
      const { lease } = await heldOn(first, clock);
      let release = (): void => undefined;
      const waiting = lease.yieldWhile(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      waiting.catch(() => undefined);
      for (let tick = 0; tick < 20; tick += 1)
        await new Promise((resolve) => setImmediate(resolve));
      const thief = await second.acquire(TREE.tenantId, TREE.rootExecutionId, seconds(30));
      expect(thief?.leaseEpoch).toBe(2);

      await expect(lease.enterStep()).rejects.toThrow(ExecutionLeaseLostError);
      expect(lease.signal.aborted).toBe(true);
      release();
      await lease.release();
    });
  },
);
