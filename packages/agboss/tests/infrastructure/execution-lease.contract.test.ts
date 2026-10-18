/**
 * #265 AC11 (Q58): `ExecutionLeaseRepository` — one lease per tree, keyed by `(tenantId,
 * rootExecutionId)`: not given to another instance while valid, taken with `leaseEpoch + 1` after
 * it expired or was released, the old holder's `renew` then `false`; the framework's holder aborts
 * its work when that happens and wakes a waiting call on release. `PausedExecutionRepository`
 * gives exactly one of two concurrent `Pending → Resolved` transitions of one pause.
 */
import { describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  InMemoryPausedExecutionRepository,
  PauseStatus,
} from "../../src/infrastructure/paused-execution.repository.js";
import type { AgentExecutionOutput } from "../../src/run/types.js";
import { createTestClock, type VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";

/** Two instances' repositories over one database and one clock. */
function twoInstances(): {
  clock: VirtualClock;
  first: InMemoryExecutionLeaseRepository;
  second: InMemoryExecutionLeaseRepository;
} {
  const clock = createTestClock();
  const database = new InMemoryDatabase();
  return {
    clock,
    first: new InMemoryExecutionLeaseRepository(clock.now, "instance-1", database),
    second: new InMemoryExecutionLeaseRepository(clock.now, "instance-2", database),
  };
}

describe("#265 AC11: the lease contract (in-memory default)", () => {
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

describe("#265 AC11: the framework's holder of a tree's lease", () => {
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
});

const pausedRun = { runId: "run-1", threadId: "thread-1", status: ExecutionStatus.Paused };

describe("#265 AC11: a pause goes from Pending to Resolved once", () => {
  it("of two concurrent transitions of one pause exactly one succeeds, with its decision", async () => {
    const repository = new InMemoryPausedExecutionRepository();
    await repository.save({
      // a paused run as the app stores it; only its thread matters here
      run: pausedRun as AgentExecutionOutput,
      workflowVersion: "1.0.0",
      configHash: "hash",
      status: PauseStatus.Pending,
    });

    const [first, second] = await Promise.all([
      repository.resolveByThreadId("thread-1", { approved: true }),
      repository.resolveByThreadId("thread-1", { approved: false }),
    ]);

    expect(first).toMatchObject({ status: PauseStatus.Resolved, decision: { approved: true } });
    expect(second).toBeUndefined();
    expect(await repository.resolveByThreadId("no-such-thread", {})).toBeUndefined();
  });
});
