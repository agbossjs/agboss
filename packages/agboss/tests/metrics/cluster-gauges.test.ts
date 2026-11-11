/**
 * #485 AC1 — the cluster's queued work, read from the shared child queue: with three instances and
 * twelve queued children, every instance reads 12 — never 36 —, its running children and how long
 * the oldest has waited; `max` over the instances is the store's value, `sum` is not. A store read
 * that fails reports no cluster value, and warns once per streak.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { ChildExecutionQueueRepository } from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import {
  closeGate,
  release,
  remoteLog,
  resetRemoteLog,
} from "../flow/runtime/fixtures/remote-children.workflow.js";
import {
  itemsOf,
  LoggedMetricsApplication,
  MetricsApplication,
  MetricsBatchWorkflowStart,
} from "./fixtures/metrics.application.js";
import { acrossInstances, collect, collectAll, instanceMeters } from "./support/metric-reader.js";
import { first, untilSettled } from "./support/runs.js";

const QUEUED = "agboss.cluster.children.queued";
const RUNNING = "agboss.cluster.children.running";
const OLDEST = "agboss.cluster.children.oldest_queued.age";

const three = instanceMeters(3);
const threeInstances = testWith(MetricsApplication, {
  concurrency: TestConcurrency.Real,
  instances: three.map((meter) => ({ meterProvider: meter.provider })),
});
const failing = instanceMeters(1);
const failingStore = testWith(LoggedMetricsApplication, {
  instances: failing.map((meter) => ({ meterProvider: meter.provider })),
});

beforeEach(() => {
  resetRemoteLog();
  resetLogged();
});
afterEach(() => {
  release();
  vi.restoreAllMocks();
});

/** Runs fifteen gated children on the instances; resolves once three are at the gate. */
async function fifteenQueued(
  apps: readonly TestApp[],
): Promise<{ readonly call: Promise<unknown> }> {
  for (const app of apps) await app.ready();
  closeGate();
  const call = execute(first(apps), MetricsBatchWorkflowStart, itemsOf(15));
  call.catch(() => undefined);
  await vi.waitFor(
    () => {
      expect(remoteLog.waiting).toBe(3);
    },
    { timeout: 4000 },
  );
  return { call };
}

describe("#485 AC1: cluster gauges are the store's, counted once", () => {
  threeInstances(
    "AC1: three instances, twelve queued children: every instance reads 12, never 36",
    async ({ apps, clock }) => {
      const { call } = await fifteenQueued(apps);

      // a second at a time: one jump past the lease would be a frozen holder (#511)
      for (let second = 0; second < 40; second += 1) await clock.advance(seconds(1));
      const collections = await collectAll(three);

      expect(acrossInstances(collections, QUEUED)).toEqual([12, 12, 12]);
      expect(acrossInstances(collections, RUNNING)).toEqual([3, 3, 3]);
      const ages = acrossInstances(collections, OLDEST);
      expect(new Set(ages).size).toBe(1); // one store value, whichever instance reads it
      expect(ages[0]).toBeGreaterThanOrEqual(40);
      // the rule: max over the instances is the cluster's value; a sum triple-counts it
      const queued = acrossInstances(collections, QUEUED).map(Number);
      const store = await first(apps).resolve(ChildExecutionQueueRepository).countByStatus();
      expect(Math.max(...queued)).toBe(store.queued);
      expect(queued.reduce((sum, value) => sum + value, 0)).not.toBe(12);
      release();
      await untilSettled(call, clock);
      expect(acrossInstances(await collectAll(three), QUEUED)).toEqual([0, 0, 0]);
      expect(acrossInstances(await collectAll(three), OLDEST)).toEqual([0, 0, 0]);
    },
  );

  failingStore(
    "AC1: a failed store read reports no cluster value, and warns once per streak",
    async ({ app }) => {
      await app.ready();
      const queue = app.resolve(ChildExecutionQueueRepository);
      const read = vi.spyOn(queue, "countByStatus").mockRejectedValue(new Error("db down"));
      const [meter] = failing;
      if (meter === undefined) throw new Error("no meter");

      const first = await collect(meter);
      await collect(meter);

      expect(first.get(QUEUED)?.points ?? []).toEqual([]);
      expect(first.get(OLDEST)?.points ?? []).toEqual([]);
      expect(first.get("agboss.instance.leases.held")?.points).toHaveLength(1);
      const warned = () =>
        logged.filter((entry) => entry.code === "metrics.child-queue-unreadable");
      expect(warned()).toHaveLength(1);

      read.mockRestore();
      expect(acrossInstances([await collect(meter)], QUEUED)).toEqual([0]);
      vi.spyOn(queue, "countByStatus").mockRejectedValue(new Error("db down again"));
      await collect(meter);
      expect(warned()).toHaveLength(2);
    },
  );
});
