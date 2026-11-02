/**
 * #485 — `agboss.instance.leases.held`: a held lease counts from its take until it is released or
 * lost, once; a lease already over when handed in is not counted. On real leases: a take counts,
 * its release uncounts.
 */
import { describe, expect, it } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { HeldLeaseTally } from "../../src/metrics/held-lease-tally.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { VirtualClock } from "../../src/testing/clock.js";

describe("#485: the held-lease tally", () => {
  it("counts a lease until its signal aborts, once; one already over is not counted", () => {
    const tally = new HeldLeaseTally();
    const first = new AbortController();
    const second = new AbortController();
    const over = new AbortController();
    over.abort();

    tally.hold(first.signal);
    tally.hold(second.signal);
    tally.hold(over.signal);
    expect(tally.held).toBe(2);
    first.abort();
    first.abort();
    expect(tally.held).toBe(1);
    second.abort();
    expect(tally.held).toBe(0);
  });

  it("a real take counts and its release uncounts it", async () => {
    const clock = new VirtualClock();
    const context = applicationContextOf({
      name: "a",
      version: "1",
      instanceId: "instance-1",
      startedAt: clock.now(),
      environmentName: "test",
      environment: NO_ENVIRONMENT_VALUES,
    });
    const repository = new InMemoryExecutionLeaseRepository(clock, context, new InMemoryDatabase());
    const heldLeases = new HeldLeaseTally();
    const leases = executionLeasesOf(repository, clock, { heldLeases });

    const one = await leases.hold({ tenantId: "default", rootExecutionId: "r-1" });
    const two = await leases.hold({ tenantId: "default", rootExecutionId: "r-2" });
    expect(heldLeases.held).toBe(2);
    await one.release();
    await one.release();
    expect(heldLeases.held).toBe(1);
    await two.release({ isFinished: true });
    expect(heldLeases.held).toBe(0);
  });
});
