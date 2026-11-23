/**
 * #1366: an instance's exported metrics are the stores' values at collection: queue depth and the oldest queued
 * child's age in seconds, the pause mailboxes, held leases and step slots; a failed store read reports none of its
 * gauges and is logged once per failure streak (under its own code), the meter is scoped to the framework at its version.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { InstanceMetrics, METER_NAME } from "../../src/metrics/instance-metrics.js";
import { collect, instanceMeter, valueOf } from "./support/metric-reader.js";

const T0 = 1_700_000_000_000;

interface Fakes {
  queue: { countByStatus: ReturnType<typeof vi.fn> };
  pauses: { countNotices: ReturnType<typeof vi.fn> };
  warn: ReturnType<typeof vi.fn>;
}

function build(opts: { oldestAgoMs?: number; slots?: boolean } = {}) {
  const meter = instanceMeter();
  const fakes: Fakes = {
    queue: {
      countByStatus: vi.fn(() =>
        Promise.resolve({
          queued: 4,
          running: 2,
          oldestQueuedAt:
            opts.oldestAgoMs === undefined ? undefined : new Date(T0 - opts.oldestAgoMs),
        }),
      ),
    },
    pauses: { countNotices: vi.fn(() => Promise.resolve({ live: 5, dead: 1 })) },
    warn: vi.fn(),
  };
  const metrics = new InstanceMetrics({
    meterProvider: meter.provider,
    queue: fakes.queue as never,
    pauses: fakes.pauses,
    clock: { now: () => new Date(T0) } as never,
    log: { info: vi.fn(), warn: fakes.warn, error: vi.fn() },
    stepSlots: opts.slots
      ? ({
          maxConcurrentSteps: 8,
          busySlots: () => 3,
          freeSlots: () => 5,
          waitingSteps: () => 2,
        } as never)
      : undefined,
  });
  return { meter, fakes, metrics };
}

describe("#1366: InstanceMetrics values", () => {
  it("exports the queue depth and the oldest queued child's age in seconds", async () => {
    const { meter } = build({ oldestAgoMs: 42_000 });
    const c = await collect(meter);
    expect(valueOf(c, "agboss.cluster.children.queued")).toBe(4);
    expect(valueOf(c, "agboss.cluster.children.running")).toBe(2);
    expect(valueOf(c, "agboss.cluster.children.oldest_queued.age")).toBe(42);
  });

  it("exports age 0 when nothing is queued", async () => {
    const { meter } = build();
    expect(valueOf(await collect(meter), "agboss.cluster.children.oldest_queued.age")).toBe(0);
  });

  it("never exports a negative age (a clock behind the queue's)", async () => {
    const { meter } = build({ oldestAgoMs: -5_000 });
    expect(valueOf(await collect(meter), "agboss.cluster.children.oldest_queued.age")).toBe(0);
  });

  it("exports the mailboxes, the held leases and the slots", async () => {
    const { meter, metrics } = build({ slots: true });
    const until = new AbortController();
    metrics.heldLeases.hold(until.signal);
    const c = await collect(meter);
    expect(valueOf(c, "agboss.cluster.pauses.notices.waiting")).toBe(5);
    expect(valueOf(c, "agboss.cluster.pauses.notices.dead")).toBe(1);
    expect(valueOf(c, "agboss.instance.leases.held")).toBe(1);
    expect(valueOf(c, "agboss.instance.step_slots.limit")).toBe(8);
    expect(valueOf(c, "agboss.instance.step_slots.busy")).toBe(3);
    expect(valueOf(c, "agboss.instance.step_slots.free")).toBe(5);
    expect(valueOf(c, "agboss.instance.steps.waiting")).toBe(2);
    until.abort();
    expect(valueOf(await collect(meter), "agboss.instance.leases.held")).toBe(0);
  });

  it("has no slot gauges when steps are not capped, but still the held leases", async () => {
    const { meter } = build();
    const c = await collect(meter);
    expect(c.has("agboss.instance.step_slots.limit")).toBe(false);
    expect(valueOf(c, "agboss.instance.leases.held")).toBe(0);
  });

  it("scopes the meter to the framework at its package version", async () => {
    const { meter } = build();
    const { resourceMetrics } = await meter.reader.collect();
    const scope = resourceMetrics.scopeMetrics.find((s) => s.scope.name === METER_NAME)?.scope;
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(METER_NAME).toBe("@agboss/core");
    expect(scope?.version).toBe(pkg.version);
  });
});

describe("#1366: a failed store read", () => {
  it("reports none of the queue gauges and logs once per streak, then again after a success", async () => {
    const { meter, fakes } = build();
    fakes.queue.countByStatus.mockRejectedValue(new Error("down"));
    const first = await collect(meter);
    expect(first.has("agboss.cluster.children.queued")).toBe(false);
    expect(first.has("agboss.cluster.children.oldest_queued.age")).toBe(false);
    await collect(meter);
    const queueWarns = () =>
      fakes.warn.mock.calls.filter((c) => c[0] === "metrics.child-queue-unreadable");
    expect(queueWarns()).toHaveLength(1);
    fakes.queue.countByStatus.mockResolvedValue({ queued: 1, running: 0 });
    expect(valueOf(await collect(meter), "agboss.cluster.children.queued")).toBe(1);
    fakes.queue.countByStatus.mockRejectedValue(new Error("down again"));
    await collect(meter);
    expect(queueWarns()).toHaveLength(2);
  });

  it("reports none of the mailbox gauges and logs once per streak under its own code", async () => {
    const { meter, fakes } = build();
    fakes.pauses.countNotices.mockRejectedValue(new Error("down"));
    const first = await collect(meter);
    expect(first.has("agboss.cluster.pauses.notices.waiting")).toBe(false);
    expect(first.has("agboss.cluster.pauses.notices.dead")).toBe(false);
    await collect(meter);
    const warns = () =>
      fakes.warn.mock.calls.filter((c) => c[0] === "metrics.pause-notices-unreadable");
    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.[1]).not.toBe("");
    fakes.pauses.countNotices.mockResolvedValue({ live: 2, dead: 0 });
    expect(valueOf(await collect(meter), "agboss.cluster.pauses.notices.waiting")).toBe(2);
    fakes.pauses.countNotices.mockRejectedValue(new Error("again"));
    await collect(meter);
    expect(warns()).toHaveLength(2);
  });

  it("stops reading after onDestroy", async () => {
    const { meter, fakes, metrics } = build();
    await collect(meter);
    const reads = fakes.queue.countByStatus.mock.calls.length;
    metrics.onDestroy();
    await collect(meter);
    expect(fakes.queue.countByStatus.mock.calls.length).toBe(reads);
  });
});
