/**
 * #485 AC2 — the scale-in signal of Wiki → Metrics, read as an autoscaler reads it over every
 * instance: idle = max(queued) + max(running) + Σ held leases + Σ busy + Σ waiting = 0. It is false
 * at every look while a tree moves — its parent waiting for children, a child at work, a step
 * waiting for a slot — and true only once everything ended. The scale-out demand (max(queued) +
 * Σ waiting + Σ busy) counts every step that wants a slot.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  closeGate,
  release,
  remoteLog,
  resetRemoteLog,
} from "../flow/runtime/fixtures/remote-children.workflow.js";
import {
  itemsOf,
  MetricsApplication,
  MetricsBatchWorkflowStart,
  UncappedMetricsApplication,
} from "./fixtures/metrics.application.js";
import {
  collectAll,
  instanceMeters,
  totalOf,
  type Collected,
  type InstanceMeter,
} from "./support/metric-reader.js";
import { settle } from "../app/fixtures/fence-takeover.js";
import { first, untilSettled, watched } from "./support/runs.js";

const maxOf = (collections: readonly Collected[], name: string): number =>
  Math.max(0, ...collections.map((collected) => totalOf(collected, name)));
const sumOf = (collections: readonly Collected[], name: string): number =>
  collections.reduce((sum, collected) => sum + totalOf(collected, name), 0);

/** The documented signals over every instance's collection. */
function signalsOf(collections: readonly Collected[]): { idle: boolean; demand: number } {
  const queued = maxOf(collections, "agboss.cluster.children.queued");
  const running = maxOf(collections, "agboss.cluster.children.running");
  const busy = sumOf(collections, "agboss.instance.step_slots.busy");
  const waiting = sumOf(collections, "agboss.instance.steps.waiting");
  const held = sumOf(collections, "agboss.instance.leases.held");
  return { idle: queued + running + held + busy + waiting === 0, demand: queued + waiting + busy };
}

const cappedMeters = instanceMeters(2);
const capped = testWith(MetricsApplication, {
  concurrency: TestConcurrency.Real,
  instances: cappedMeters.map((meter) => ({ meterProvider: meter.provider })),
});
const uncappedMeters = instanceMeters(2);
const uncapped = testWith(UncappedMetricsApplication, {
  concurrency: TestConcurrency.Real,
  instances: uncappedMeters.map((meter) => ({ meterProvider: meter.provider })),
});

beforeEach(resetRemoteLog);
afterEach(release);

/** Runs `count` gated children to their end; every look before the end must not read idle. */
async function runLooking(
  apps: Parameters<typeof first>[0],
  clock: Parameters<typeof untilSettled>[1],
  meters: readonly InstanceMeter[],
  count: number,
): Promise<{ looks: number; demands: number[] }> {
  for (const app of apps) await app.ready();
  expect(signalsOf(await collectAll(meters)).idle).toBe(true);
  closeGate();
  const call = execute(first(apps), MetricsBatchWorkflowStart, itemsOf(count));
  const progress = watched(call);
  const demands: number[] = [];
  let looks = 0;
  const look = async (): Promise<void> => {
    const signals = signalsOf(await collectAll(meters));
    if (progress.isSettled()) return;
    // #800: the tree's lease goes when it ends, a few turns before the caller's promise settles —
    // an idle read there is the end, not a moving tree, when the call settles right after
    if (signals.idle) await settle();
    if (progress.isSettled()) return;
    looks += 1;
    demands.push(signals.demand);
    expect(signals.idle, `look ${String(looks)}: the tree still moves`).toBe(false);
  };
  await vi.waitFor(() => {
    expect(remoteLog.waiting).toBeGreaterThan(0);
  });
  for (let held = 0; held < 3; held += 1) await look();
  release();
  // a look at every turn while the children finish, then the clock until the tree ends
  for (let turn = 0; turn < 200 && !progress.isSettled(); turn += 1) await look();
  await untilSettled(call, clock, look);
  return { looks, demands };
}

describe("#485 AC2: idle only when really idle", () => {
  capped(
    "AC2: two capped instances, six children: never idle while the tree moves, idle after; demand counts queued work",
    async ({ apps, clock }) => {
      const { looks, demands } = await runLooking(apps, clock, cappedMeters, 6);

      expect(looks).toBeGreaterThan(3);
      // two slots at work and four children queued: six steps want a slot
      expect(demands[0]).toBe(6);
      expect(signalsOf(await collectAll(cappedMeters))).toEqual({ idle: true, demand: 0 });
    },
  );

  uncapped(
    "AC2: without slot gauges the held leases and the running children keep it from reading idle",
    async ({ apps, clock }) => {
      const { looks } = await runLooking(apps, clock, uncappedMeters, 4);

      expect(looks).toBeGreaterThan(3);
      expect(signalsOf(await collectAll(uncappedMeters)).idle).toBe(true);
    },
  );
});
