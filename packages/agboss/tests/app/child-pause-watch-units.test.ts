/**
 * #1341c — the watch of a claimed child over its tree's pause, on a fixed `VirtualClock`: every 10 s the
 * root's lease row is read (the database is the authority, D6). An `Immediate` pause aborts the child at
 * once with a pause (it is parked, never stopped or failed); an `AfterStep` one lets its step finish and
 * starts none (and escalates on the next look when the pause does); no pause, another tree's pause, a
 * pause lifted before the look and a store that does not answer leave the child running.
 */
import { describe, expect, it, vi } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { ExecutionPausedError } from "../../src/app/lease-stopped.js";
import { watchRunningChild } from "../../src/app/remote/child-registry.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import type { QueuedChildExecution } from "../../src/infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { storeClockOf } from "../helpers/store-clock.js";

const ROW: QueuedChildExecution = {
  tenantId: "default",
  executionId: "child-1",
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "root",
  workflow: "child",
  depth: 2,
  status: ExecutionRecordStatus.Running,
  run: "{}",
  queuedAt: new Date(0),
};

function setup() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const context = applicationContextOf({
    ...{ name: "pause-watch", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const repository = new InMemoryExecutionLeaseRepository(storeClockOf(clock), context, database);
  const leases = executionLeasesOf(repository, clock);
  const queue = { findByTenantIdAndExecutionId: () => Promise.resolve(ROW) };
  const stop = new AbortController();
  const lease = { stopAfterStep: vi.fn() };
  const watching = (override: Partial<Parameters<typeof watchRunningChild>[0]> = {}) =>
    watchRunningChild(
      {
        clock,
        queue: queue as never,
        trees: new InMemoryExecutionTreeRepository(database),
        leases,
        ...override,
      },
      ROW,
      stop,
      lease,
    );
  return { clock, leases, stop, lease, watching, repository };
}

const ROOT = { tenantId: "default", rootExecutionId: "root-1" };

describe("#1341c: a claimed child under its tree's pause", () => {
  it("Immediate: the child is aborted with a pause at the next look, not stopped", async () => {
    const { clock, leases, stop, lease, watching } = setup();
    const watch = watching();
    await clock.advance(seconds(10));
    expect(stop.signal.aborted).toBe(false);

    await leases.requestPause(ROOT, { mode: InterruptMode.Immediate, reason: "freeze" });
    await clock.advance(seconds(10));
    await watch;

    expect(stop.signal.aborted).toBe(true);
    expect(stop.signal.reason).toBeInstanceOf(ExecutionPausedError);
    expect(lease.stopAfterStep).not.toHaveBeenCalled();
  });

  it("AfterStep: its step is not aborted and none starts after it; an escalation to Immediate aborts it", async () => {
    const { clock, leases, stop, lease, watching } = setup();
    const watch = watching();
    await leases.requestPause(ROOT, { mode: InterruptMode.AfterStep });
    await clock.advance(seconds(10));

    expect(lease.stopAfterStep).toHaveBeenCalledOnce();
    expect(lease.stopAfterStep.mock.calls[0]?.[0]).toBeInstanceOf(ExecutionPausedError);
    expect(stop.signal.aborted).toBe(false);

    await leases.requestPause(ROOT, { mode: InterruptMode.Immediate });
    await clock.advance(seconds(10));
    await watch;

    expect(stop.signal.aborted).toBe(true);
    expect(stop.signal.reason).toBeInstanceOf(ExecutionPausedError);
  });

  it("leaves it running: no pause, another tree's pause, a pause lifted before the look, a store that fails", async () => {
    const { clock, leases, stop, lease, watching } = setup();
    const watch = watching();
    await leases.requestPause(
      { tenantId: "default", rootExecutionId: "root-2" },
      { mode: InterruptMode.Immediate },
    );
    await leases.requestPause(ROOT, { mode: InterruptMode.Immediate });
    await leases.unpause(ROOT);
    await clock.advance(seconds(10));
    expect(stop.signal.aborted).toBe(false);

    vi.spyOn(leases, "pauseOf").mockRejectedValue(new Error("down"));
    await leases.requestPause(ROOT, { mode: InterruptMode.Immediate });
    await clock.advance(seconds(10));

    expect(stop.signal.aborted).toBe(false);
    expect(lease.stopAfterStep).not.toHaveBeenCalled();
    stop.abort();
    await watch;
  });
});
