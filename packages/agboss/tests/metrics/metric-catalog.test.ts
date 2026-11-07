/**
 * #485 AC4, AC5 — the metrics are a contract: their names, kinds, units and label keys are the
 * documented ones (Wiki → Metrics; a change here is an announced change), an in-memory
 * OpenTelemetry reader gets them with their values, label values are bounded by the code (never a
 * tenant, an execution or a thread), an application with no meter provider reads no store for
 * metrics, and a closed instance's callbacks are gone.
 */
import { DataPointType } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChildExecutionQueueRepository,
  CompensationStatus,
  ExecutionCancelledError,
  HandOverReason,
  LeaseTakeoverReason,
  type CompensationEndEvent,
  type ExecutionErrorEvent,
  type ExecutionLeaseTakeoverEvent,
  type StepHandedOverEvent,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { METRICS, MetricKind } from "../../src/metrics/metric-catalog.js";
import { metricsObserverOf } from "../../src/metrics/metrics-observer.js";
import { execute } from "../helpers/flow.js";
import {
  resetRemoteLog,
  RemoteItemWorkflowStart,
} from "../flow/runtime/fixtures/remote-children.workflow.js";
import { MetricsApplication } from "./fixtures/metrics.application.js";
import { collect, instanceMeter, type Collected } from "./support/metric-reader.js";

/** The announced catalog: name → kind, unit, label keys. */
const DOCUMENTED = {
  "agboss.cluster.children.queued": [MetricKind.ObservableGauge, "{execution}", []],
  "agboss.cluster.children.running": [MetricKind.ObservableGauge, "{execution}", []],
  "agboss.cluster.children.oldest_queued_seconds": [MetricKind.ObservableGauge, "s", []],
  "agboss.instance.step_slots.limit": [MetricKind.ObservableGauge, "{slot}", []],
  "agboss.instance.step_slots.busy": [MetricKind.ObservableGauge, "{slot}", []],
  "agboss.instance.step_slots.free": [MetricKind.ObservableGauge, "{slot}", []],
  "agboss.instance.steps.waiting": [MetricKind.ObservableGauge, "{step}", []],
  "agboss.instance.leases.held": [MetricKind.ObservableGauge, "{lease}", []],
  "agboss.instance.lease.takeovers": [MetricKind.Counter, "{takeover}", ["reason"]],
  "agboss.instance.steps.handed_over": [MetricKind.Counter, "{step}", ["reason"]],
  "agboss.instance.executions.ended": [MetricKind.Counter, "{execution}", ["workflow", "outcome"]],
  "agboss.instance.compensations": [MetricKind.Counter, "{action}", ["workflow", "status"]],
} as const;

const KIND_OF_TYPE: Readonly<Record<string, MetricKind>> = {
  [DataPointType.GAUGE]: MetricKind.ObservableGauge,
  [DataPointType.SUM]: MetricKind.Counter,
};

/** Every label value the code can give, by key. */
const BOUNDED: Readonly<Record<string, readonly string[]>> = {
  reason: [...Object.values(LeaseTakeoverReason), ...Object.values(HandOverReason)],
  outcome: ["finished", "failed", "cancelled"],
  status: Object.values(CompensationStatus),
  workflow: ["metrics-batch-workflow", "remote-item-workflow"],
};

const meter = instanceMeter();
const metered = testWith(MetricsApplication, { instances: [{ meterProvider: meter.provider }] });
const unmetered = testWith(MetricsApplication);
const closing = instanceMeter();
const closed = testWith(MetricsApplication, { instances: [{ meterProvider: closing.provider }] });

beforeEach(resetRemoteLog);
afterEach(() => {
  vi.restoreAllMocks();
});

/** An event with only the fields the metrics read (and ids they must never read). */
const eventOf = <TEvent>(fields: Partial<TEvent> & object): TEvent => fields as TEvent;

/** Each collected metric's kind, unit and label keys. */
const shapesOf = (collected: Collected) =>
  Object.fromEntries(
    [...collected.values()].map(({ data, points }) => [
      data.descriptor.name,
      [
        KIND_OF_TYPE[data.dataPointType],
        data.descriptor.unit,
        [...new Set(points.flatMap((point) => Object.keys(point.attributes)))],
      ],
    ]),
  );

describe("#485 AC4: the catalog", () => {
  it("AC4: the names, kinds, units and label keys are the documented ones", () => {
    const catalog = Object.fromEntries(
      Object.values(METRICS).map((spec) => [spec.name, [spec.kind, spec.unit, spec.labels]]),
    );

    expect(catalog).toEqual(DOCUMENTED);
    for (const spec of Object.values(METRICS)) expect(spec.description.length).toBeGreaterThan(10);
  });

  it("AC4: every counter's label comes from an event's enum or workflow name, never an id", async () => {
    const { provider, reader } = instanceMeter();
    const observer = metricsObserverOf(provider.getMeter("test"));
    const workflow = {
      name: "remote-item-workflow",
      version: "1.0.0",
      startedVersion: "1.0.0",
      configHash: "c0ffee",
    };
    // the ids an event carries: none of them may become a label
    const ids = { executionId: "e-1", tenantId: "t-1", threadId: "th-1", rootExecutionId: "r-1" };
    await observer.onExecutionLeaseTakeover?.(
      eventOf<ExecutionLeaseTakeoverEvent>({ ...ids, reason: LeaseTakeoverReason.RemoteChild }),
    );
    await observer.onStepHandedOver?.(
      eventOf<StepHandedOverEvent>({ ...ids, workflow, reason: HandOverReason.Fenced }),
    );
    const cancelled = new ExecutionCancelledError("cancelled");
    await observer.onExecutionError?.(
      eventOf<ExecutionErrorEvent>({ ...ids, workflow, error: cancelled }),
    );
    await observer.onExecutionError?.(
      eventOf<ExecutionErrorEvent>({ ...ids, workflow, error: new Error("boom") }),
    );
    await observer.onCompensationEnd?.(
      eventOf<CompensationEndEvent>({ ...ids, workflow, status: CompensationStatus.Failed }),
    );

    const collected = await collect({ provider, reader });
    const points = [...collected.values()].flatMap((metric) => metric.points);
    expect(points.map((point) => point.attributes)).toEqual([
      { reason: "remote-child" },
      { reason: "fenced" },
      { workflow: "remote-item-workflow", outcome: "cancelled" },
      { workflow: "remote-item-workflow", outcome: "failed" },
      { workflow: "remote-item-workflow", status: "failed" },
    ]);
  });
});

describe("#485 AC5: through an in-memory OpenTelemetry reader", () => {
  metered(
    "AC5: an in-memory OTel reader gets the same names and values; 30 executions over 10 tenants keep the labels bounded",
    async ({ app }) => {
      for (let run = 0; run < 30; run += 1) {
        const tenant = { tenantId: `tenant-${String(run % 10)}` };
        const outcome = run % 7 === 0 ? ("fail" as const) : ("ok" as const);
        await execute(
          app,
          RemoteItemWorkflowStart,
          { name: `i-${String(run)}`, delay: 0, outcome },
          {
            tenant,
          },
        ).catch(() => undefined);
      }

      const collected = await collect(meter);

      const shapes = shapesOf(collected);
      for (const [name, shape] of Object.entries(shapes))
        expect(shape, name).toEqual(DOCUMENTED[name as keyof typeof DOCUMENTED]);
      expect(Object.keys(shapes)).toEqual(
        expect.arrayContaining([
          "agboss.cluster.children.queued",
          "agboss.instance.step_slots.busy",
          "agboss.instance.leases.held",
          "agboss.instance.executions.ended",
        ]),
      );
      const ended = collected.get("agboss.instance.executions.ended")?.points ?? [];
      expect(ended.map((point) => [point.attributes, point.value])).toEqual(
        expect.arrayContaining([
          [{ workflow: "remote-item-workflow", outcome: "finished" }, 25],
          [{ workflow: "remote-item-workflow", outcome: "failed" }, 5],
        ]),
      );
      for (const { points } of collected.values())
        for (const point of points)
          for (const [key, value] of Object.entries(point.attributes))
            expect(BOUNDED[key], `${key}=${String(value)}`).toContain(value);
    },
  );

  unmetered("AC5: no meter provider — no store is read for metrics", async ({ app, clock }) => {
    await app.ready();
    const read = vi.spyOn(app.resolve(ChildExecutionQueueRepository), "findQueueDepth");

    await execute(app, RemoteItemWorkflowStart, { name: "a", delay: 0, outcome: "ok" });
    for (let second = 0; second < 5; second += 1) await clock.advance(seconds(1));

    expect(read).not.toHaveBeenCalled();
  });

  closed("AC5: after close() no callback reads a store", async ({ app }) => {
    await app.ready();
    const read = vi.spyOn(app.resolve(ChildExecutionQueueRepository), "findQueueDepth");
    await collect(closing);
    expect(read).toHaveBeenCalledTimes(1);

    await app.close();
    await collect(closing);
    await collect(closing);

    // the SDK may repeat a gauge's last value; what matters is that nothing asks a closed store
    expect(read).toHaveBeenCalledTimes(1);
  });
});
