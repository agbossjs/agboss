/**
 * #485 AC2 — an instance's own numbers follow its steps: busy and free slots, the steps waiting for
 * one and the tree leases it holds change as steps start and end, and an idle instance reads 0
 * busy, 0 waiting, 0 held. Without `maxConcurrentSteps` there are no slot gauges; leases still count.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  closeGate,
  release,
  remoteLog,
  resetRemoteLog,
  RemoteItemWorkflowStart,
} from "../flow/runtime/fixtures/remote-children.workflow.js";
import { MetricsApplication, UncappedMetricsApplication } from "./fixtures/metrics.application.js";
import { collect, instanceMeter, valueOf, type Collected } from "./support/metric-reader.js";
import { untilSettled } from "./support/runs.js";

const capped = instanceMeter();
const cappedTest = testWith(MetricsApplication, {
  concurrency: TestConcurrency.Real,
  instances: [{ meterProvider: capped.provider }],
});
const uncapped = instanceMeter();
const uncappedTest = testWith(UncappedMetricsApplication, {
  concurrency: TestConcurrency.Real,
  instances: [{ meterProvider: uncapped.provider }],
});

beforeEach(resetRemoteLog);
afterEach(release);

const item = (name: string) => ({ name, delay: 0, outcome: "ok" as const });

/** The instance's own gauges in one collection. */
const ownOf = (collected: Collected) => ({
  limit: valueOf(collected, "agboss.instance.step_slots.limit"),
  busy: valueOf(collected, "agboss.instance.step_slots.busy"),
  free: valueOf(collected, "agboss.instance.step_slots.free"),
  waiting: valueOf(collected, "agboss.instance.steps.waiting"),
  held: valueOf(collected, "agboss.instance.leases.held"),
});

describe("#485 AC2: the instance's slots and leases follow its steps", () => {
  cappedTest(
    "AC2: busy and free follow steps as they start and end; an idle instance reads 0 busy",
    async ({ app, clock }) => {
      await app.ready();
      expect(ownOf(await collect(capped))).toEqual({
        limit: 1,
        busy: 0,
        free: 1,
        waiting: 0,
        held: 0,
      });
      closeGate();

      const one = execute(app, RemoteItemWorkflowStart, item("a"));
      const two = execute(app, RemoteItemWorkflowStart, item("b"));
      await vi.waitFor(async () => {
        expect(remoteLog.waiting).toBe(1);
        expect(ownOf(await collect(capped)).waiting).toBe(1);
      });

      // one step at work, one waiting for the slot; both roots hold their tree's lease
      expect(ownOf(await collect(capped))).toEqual({
        limit: 1,
        busy: 1,
        free: 0,
        waiting: 1,
        held: 2,
      });
      release();
      await untilSettled(Promise.all([one, two]), clock);
      expect(ownOf(await collect(capped))).toEqual({
        limit: 1,
        busy: 0,
        free: 1,
        waiting: 0,
        held: 0,
      });
    },
  );

  uncappedTest(
    "AC2: without maxConcurrentSteps: no slot gauges, the held leases still counted",
    async ({ app, clock }) => {
      await app.ready();
      closeGate();
      const call = execute(app, RemoteItemWorkflowStart, item("a"));
      await vi.waitFor(() => {
        expect(remoteLog.waiting).toBe(1);
      });

      const during = await collect(uncapped);

      expect(ownOf(during)).toEqual({
        limit: undefined,
        busy: undefined,
        free: undefined,
        waiting: undefined,
        held: 1,
      });
      expect([...during.keys()].filter((name) => name.includes("step_slots"))).toEqual([]);
      release();
      await untilSettled(call, clock);
      expect(ownOf(await collect(uncapped)).held).toBe(0);
    },
  );
});
