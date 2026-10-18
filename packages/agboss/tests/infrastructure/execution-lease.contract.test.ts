/**
 * #265 AC11 (Q58): `ExecutionLeaseRepository` — one lease per tree, keyed by `(tenantId,
 * rootExecutionId)`: not given to another instance while valid, taken with `leaseEpoch + 1` after
 * it expired or was released, the old holder's `renew` then `false`; the framework's holder aborts
 * its work when that happens and wakes a waiting call on release. One suite, run against the
 * in-memory default and `SqliteExecutionLeaseRepository` (two instances on one file). The pause
 * transition is in paused-execution.contract.test.ts.
 */
import { describe, expect, it } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { ExecutionLeaseLostError, type ExecutionLeaseRepository } from "../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { seconds } from "../../src/units/index.js";
import { storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<ExecutionLeaseRepository>({
  inMemory: ({ clock, instanceId, database }) =>
    new InMemoryExecutionLeaseRepository(clock.now, instanceId, database),
  sqlite: ({ clock, instanceId, connection }) =>
    new SqliteExecutionLeaseRepository(connection(), clock.now, instanceId),
});

describe.each(kinds)("#265 AC11: the lease contract ($name)", ({ twoInstances }) => {
  it("a tree's lease held by one instance is not given to the other", async () => {
    const { first, second } = twoInstances();

    const held = await first.acquire("default", "root-1", seconds(30));
    const refused = await second.acquire("default", "root-1", seconds(30));

    expect(held).toMatchObject({
      tenantId: "default",
      rootExecutionId: "root-1",
      holderInstanceId: "instance-1",
      leaseEpoch: 1,
      expiresAt: new Date("2026-01-05T09:00:30.000Z"),
    });
    expect(refused).toBeUndefined();
  });

  it("past the lease the other takes it with leaseEpoch + 1, and the old holder's renew is false", async () => {
    const { clock, first, second } = twoInstances();
    const old = await first.acquire("default", "root-1", seconds(30));

    await clock.advance(seconds(31));
    const taken = await second.acquire("default", "root-1", seconds(30));

    expect(taken).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    expect(old && (await first.renew(old, seconds(30)))).toBe(false);
    expect(taken && (await second.renew(taken, seconds(30)))).toBe(true);
  });

  it("a lease renewed exactly at expiry, not taken meanwhile, is kept", async () => {
    const { clock, first, second } = twoInstances();
    const held = await first.acquire("default", "root-1", seconds(30));

    await clock.advance(seconds(30));
    const renewed = held && (await first.renew(held, seconds(30)));

    expect(renewed).toBe(true);
    expect(await second.acquire("default", "root-1", seconds(30))).toBeUndefined();
  });

  it("a released lease is taken at once with leaseEpoch + 1; another tenant's tree is its own", async () => {
    const { first, second } = twoInstances();
    const held = await first.acquire("default", "root-1", seconds(30));
    if (held !== undefined) await first.release(held);

    const next = await second.acquire("default", "root-1", seconds(30));
    const otherTenant = await second.acquire("acme", "root-1", seconds(30));

    expect(next).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    expect(otherTenant).toMatchObject({ tenantId: "acme", leaseEpoch: 1 });
  });

  it("releasing a lost lease leaves the new holder's", async () => {
    const { clock, first, second } = twoInstances();
    const old = await first.acquire("default", "root-1", seconds(30));
    await clock.advance(seconds(31));
    const taken = await second.acquire("default", "root-1", seconds(30));

    if (old !== undefined) await first.release(old);

    expect(taken && (await second.renew(taken, seconds(30)))).toBe(true);
    expect(await first.acquire("default", "root-1", seconds(30))).toBeUndefined();
  });
});

describe.each(kinds)(
  "#265 AC11: the framework's holder of a tree's lease ($name)",
  ({ twoInstances }) => {
    it("a holder frozen past the lease loses it to the waiting instance: its signal aborts", async () => {
      const { clock, first, second } = twoInstances();
      const holder = await executionLeasesOf(first, clock.timers).hold("root-1");
      const waiting = executionLeasesOf(second, clock.timers).hold("root-1");

      await clock.advance(seconds(31));
      const taken = await waiting;

      expect(holder.signal.aborted).toBe(true);
      expect(holder.signal.reason).toBeInstanceOf(ExecutionLeaseLostError);
      await expect(holder.renewNow()).rejects.toBeInstanceOf(ExecutionLeaseLostError);
      expect(taken.signal.aborted).toBe(false);
      await taken.release();
      await holder.release();
    });

    it("a live holder renews every third of the lease: the waiting call waits", async () => {
      const { clock, first, second } = twoInstances();
      const holder = await executionLeasesOf(first, clock.timers).hold("root-1");
      let taken = false;
      const waiting = executionLeasesOf(second, clock.timers)
        .hold("root-1")
        .then((lease) => {
          taken = true;
          return lease;
        });

      for (let step = 0; step < 9; step += 1) await clock.advance(seconds(10));

      expect(taken).toBe(false);
      expect(holder.signal.aborted).toBe(false);
      await holder.release();
      await (await waiting).release();
      expect(taken).toBe(true);
    });

    it("a release wakes the waiting call at once, without the clock", async () => {
      const { clock, first, second } = twoInstances();
      const holder = await executionLeasesOf(first, clock.timers).hold("root-1");
      const waiting = executionLeasesOf(second, clock.timers).hold("root-1");

      await holder.release();
      const taken = await waiting;

      expect(taken.signal.aborted).toBe(false);
      await taken.release();
    });

    it("the caller's signal ends the wait with its reason", async () => {
      const { clock, first, second } = twoInstances();
      const holder = await executionLeasesOf(first, clock.timers).hold("root-1");
      const cancelled = new AbortController();
      const waiting = executionLeasesOf(second, clock.timers).hold("root-1", cancelled.signal);

      cancelled.abort(new Error("the caller gave up"));

      await expect(waiting).rejects.toThrow("the caller gave up");
      await holder.release();
    });
  },
);
