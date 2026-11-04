/**
 * #751 — what the scale-in signal of Wiki → Metrics does not see: a root handed over by a graceful
 * stop (its record `running`, its lease released) is on no gauge of any instance until another
 * instance's recovery sweep takes it — idle reads true in that window, which is why the docs keep
 * `minReplicaCount ≥ 1` (a live instance's sweep is what continues it). Once taken, its lease and
 * its step count again, and idle reads false until it ends.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  closeGate,
  release,
  remoteLog,
  resetRemoteLog,
  RemoteItemWorkflowStart,
} from "../flow/runtime/fixtures/remote-children.workflow.js";
import { MetricsApplication } from "./fixtures/metrics.application.js";
import { collectAll, instanceMeters, totalOf, type Collected } from "./support/metric-reader.js";

const SIGNAL = [
  "agboss.cluster.children.queued",
  "agboss.cluster.children.running",
  "agboss.instance.leases.held",
  "agboss.instance.step_slots.busy",
  "agboss.instance.steps.waiting",
] as const;

/** The idle sum over the surviving instance's collection alone (the stopped one reports nothing). */
const idleSumOf = (survivor: Collected | undefined): number =>
  SIGNAL.reduce((sum, name) => sum + (survivor === undefined ? 0 : totalOf(survivor, name)), 0);

const meters = instanceMeters(2);
const pair = testWith(MetricsApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
  meterProviders: meters.map((meter) => meter.provider),
});

beforeEach(resetRemoteLog);
afterEach(release);

describe("#751: a handed-over root waits for the sweep on no gauge", () => {
  pair(
    "idle reads true between the hand-over and the other instance's sweep, false once it takes the root",
    async ({ apps, clock }) => {
      const [stopping, survivor] = apps;
      if (stopping === undefined || survivor === undefined) throw new Error("two instances");
      await stopping.ready();
      await survivor.ready();
      closeGate();
      const run = execute(stopping, RemoteItemWorkflowStart, {
        name: "item-0",
        delay: 0,
        outcome: "ok",
      });
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(remoteLog.waiting).toBe(1);
      });

      const closed = stopping.close({ timeout: seconds(1) });
      await clock.advance(seconds(1));
      await closed;
      const [, beforeSweep] = await collectAll(meters);

      // the window: nothing queued, held or at work anywhere — and the root still to finish
      expect(idleSumOf(beforeSweep)).toBe(0);

      await clock.advance(seconds(31));
      await vi.waitFor(async () => {
        const [, afterSweep] = await collectAll(meters);
        expect(idleSumOf(afterSweep)).toBeGreaterThan(0);
      });
    },
  );
});
