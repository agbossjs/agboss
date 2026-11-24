/**
 * #943 AC2: the pause metrics — pauses opened, closed by reason, the time to answer, extensions,
 * answers no step took, and the notices waiting / set aside — counted once, on the instance that
 * applied the change; labels are the workflow, the channel's name and a reason, never an id.
 */
import { DataPointType } from "@opentelemetry/sdk-metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { closeTreePauses } from "../../src/app/tree-end-pauses.js";
import { withdrawPause } from "../../src/flow/runtime/launch/withdrawn-pauses.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { RandomIdGenerator } from "../../src/infrastructure/clock.js";
import { NO_RECIPIENTS, PauseResolution } from "../../src/infrastructure/pause-record.js";
import { METRICS, MetricKind, TIME_TO_ANSWER_BUCKETS } from "../../src/metrics/metric-catalog.js";
import { pauseTallyOn } from "../../src/metrics/pause-metrics.js";
import type { PauseTally } from "../../src/pause/pause-tally.js";
import { testWith } from "../../src/testing/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { APPROVED_BY_MANAGER, pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { hours, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ListingApplication,
  asked,
  financeFlow,
  managerFlow,
  ownerFlow,
  resetAsked,
} from "../flow/fixtures/list-pauses.fixture.js";
import {
  collect,
  instanceMeter,
  instanceMeters,
  type InstanceMeter,
  valueOf,
} from "./support/metric-reader.js";

const OPENED = "agboss.instance.pauses.opened";
const CLOSED = "agboss.instance.pauses.closed";
const TIME_TO_ANSWER = "agboss.instance.pauses.time_to_answer";
const TIMEOUT_CHANGED = "agboss.instance.pauses.timeout_changed";
const REASSIGNED = "agboss.instance.pauses.reassigned";
const NOT_TAKEN = "agboss.instance.pauses.answers_not_taken";

interface Instances {
  readonly apps: readonly TestApp[];
  readonly clock: VirtualClock;
}

/** A test on two instances with meters of its own: it never sees another test's counts. */
function metered(
  name: string,
  body: (context: Instances & { readonly meters: readonly InstanceMeter[] }) => Promise<void>,
): void {
  const meters = instanceMeters(2);
  const two = testWith(ListingApplication, {
    instances: meters.map((meter) => ({ meterProvider: meter.provider })),
  });
  two(name, ({ apps, clock }) => body({ apps, clock, meters }));
}
const manager = { answeredBy: "manager-17" };

beforeEach(resetAsked);

/** One metric's value over both instances' collections. */
async function totalOn(
  meters: readonly InstanceMeter[],
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  let total = 0;
  for (const meter of meters) total += valueOf(await collect(meter), name, labels) ?? 0;
  return total;
}

/** Every point of the `time_to_answer` histogram on every instance, its kind and unit checked. */
async function histogramPointsOf(meters: readonly InstanceMeter[]) {
  const found = [];
  for (const meter of meters) {
    const data = (await collect(meter)).get(TIME_TO_ANSWER)?.data;
    if (data === undefined) continue;
    expect(data.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(data.descriptor.unit).toBe("s");
    if (data.dataPointType === DataPointType.HISTOGRAM) found.push(...data.dataPoints);
  }
  return found;
}

/** The target is the pause's channel name until its record keeps the two apart (#1307d). */
const labelsOf = (workflow: string, channel: string, reason?: string) => ({
  workflow,
  target: channel,
  channel,
  ...(reason === undefined ? {} : { reason }),
});

describe("#943 AC2: the catalog of the pause metrics", () => {
  it("names, kinds, units and labels are the announced ones; the histogram has explicit buckets", () => {
    const pick = (spec: (typeof METRICS)[keyof typeof METRICS]) => [
      spec.name,
      spec.kind,
      spec.unit,
      spec.labels,
    ];
    expect([
      pick(METRICS.pausesOpened),
      pick(METRICS.pausesClosed),
      pick(METRICS.pausesTimeToAnswer),
      pick(METRICS.pausesTimeoutChanged),
      pick(METRICS.pausesReassigned),
      pick(METRICS.pausesAnswersNotTaken),
      pick(METRICS.noticesWaiting),
      pick(METRICS.noticesDead),
    ]).toEqual([
      [OPENED, MetricKind.Counter, "{pause}", ["workflow", "target", "channel"]],
      [CLOSED, MetricKind.Counter, "{pause}", ["workflow", "target", "channel", "reason"]],
      [TIME_TO_ANSWER, MetricKind.Histogram, "s", ["workflow", "target", "channel"]],
      [TIMEOUT_CHANGED, MetricKind.Counter, "{pause}", ["workflow", "target", "channel"]],
      [REASSIGNED, MetricKind.Counter, "{pause}", ["workflow", "target", "channel"]],
      [NOT_TAKEN, MetricKind.Counter, "{pause}", ["workflow", "target", "channel", "reason"]],
      ["agboss.cluster.pauses.notices.waiting", MetricKind.ObservableGauge, "{mailbox}", []],
      ["agboss.cluster.pauses.notices.dead", MetricKind.ObservableGauge, "{mailbox}", []],
    ]);
    expect(TIME_TO_ANSWER_BUCKETS).toEqual([60, 300, 900, 3600, 14400, 86400, 259200]);
  });
});

describe("#943 AC2: counted once, on the instance that applied the change", () => {
  metered(
    "opened once per pause; a re-entry after the answer does not count",
    async ({ apps, meters }) => {
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances");
      const paused = await execute(
        first,
        ownerFlow.start,
        { orderId: "o-1", note: "n" },
        { threadId: "m-1", ownerId: "alice" },
      );
      const labels = labelsOf("list-owner-workflow", ownerFlow.role);
      expect(await totalOn(meters, OPENED, labels)).toBe(1);

      // the answer re-enters the step, on the other instance: found sent, never asked again
      await second.resume(
        { pauseId: paused.pending[0]?.pauseId ?? "", decision: { approved: true } },
        { ownerId: "alice" },
      );

      expect(await totalOn(meters, OPENED, labels)).toBe(1);
      expect(valueOf(await collect(meters[1] ?? instanceMeter()), OPENED, labels)).toBeUndefined();
    },
  );

  metered(
    "closed by reason — answered, expired, cancelled — each once across 2 instances",
    async ({ apps, clock, meters }) => {
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances");
      await execute(first, managerFlow.start, { orderId: "a", note: "n" }, { threadId: "c-a" });
      await execute(first, financeFlow.start, { orderId: "b", note: "n" }, { threadId: "c-b" });
      await execute(first, managerFlow.start, { orderId: "c", note: "n" }, { threadId: "c-c" });
      await clock.advance(minutes(10));
      await second.resume(
        { pauseId: asked.sent[0]?.pauseId ?? "", decision: { approved: true } },
        manager,
      );
      await first.cancel("c-c");
      await clock.advance(hours(3));
      for (
        let tick = 0;
        tick < 200 &&
        (await totalOn(meters, CLOSED, {
          ...labelsOf("list-finance-workflow", financeFlow.role, "expired"),
        })) === 0;
        tick += 1
      )
        await new Promise((resolve) => setImmediate(resolve));

      const closed = (workflow: string, role: string, reason: string) =>
        totalOn(meters, CLOSED, labelsOf(workflow, role, reason));
      expect(await closed("list-manager-workflow", managerFlow.role, "answered")).toBe(1);
      expect(await closed("list-manager-workflow", managerFlow.role, "cancelled")).toBe(1);
      expect(await closed("list-finance-workflow", financeFlow.role, "expired")).toBe(1);
      // the answer was recorded by the second instance: counted there, not on the first
      expect(
        valueOf(
          await collect(meters[1] ?? instanceMeter()),
          CLOSED,
          labelsOf("list-manager-workflow", managerFlow.role, "answered"),
        ),
      ).toBe(1);
      expect(
        valueOf(
          await collect(meters[0] ?? instanceMeter()),
          CLOSED,
          labelsOf("list-manager-workflow", managerFlow.role, "answered"),
        ),
      ).toBeUndefined();
    },
  );

  metered(
    "time_to_answer: only a human's answer, resolvedAt - askedAt, in seconds",
    async ({ apps, clock, meters }) => {
      const [first] = apps;
      if (first === undefined) throw new Error("an instance");
      await execute(first, managerFlow.start, { orderId: "t", note: "n" }, { threadId: "tt-1" });
      await execute(first, financeFlow.start, { orderId: "u", note: "n" }, { threadId: "tt-2" });
      await clock.advance(minutes(10));
      await first.resume(
        { pauseId: asked.sent[0]?.pauseId ?? "", decision: { approved: true } },
        manager,
      );
      // finance expires: an expiry is a close, not an answer time
      await clock.advance(hours(3));
      for (let tick = 0; tick < 200; tick += 1)
        await new Promise((resolve) => setImmediate(resolve));

      const found = await histogramPointsOf(meters);
      expect(found).toHaveLength(1);
      const [point] = found;
      expect(point?.attributes).toEqual({
        workflow: "list-manager-workflow",
        target: managerFlow.role,
        channel: managerFlow.role,
      });
      expect(point?.value.count).toBe(1);
      expect(point?.value.sum).toBe(600);
      expect(point?.value.buckets.boundaries).toEqual([...TIME_TO_ANSWER_BUCKETS]);
      // 600 s: in the 300-900 bucket
      expect(point?.value.buckets.counts).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
    },
  );

  metered("timeout_changed once per applied extension", async ({ apps, clock, meters }) => {
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances");
    await execute(first, managerFlow.start, { orderId: "x", note: "n" }, { threadId: "x-1" });
    await clock.advance(hours(1));

    await second.extendPause(
      { pauseId: asked.sent[0]?.pauseId ?? "", expiresIn: hours(24) },
      manager,
    );

    expect(
      await totalOn(meters, TIMEOUT_CHANGED, labelsOf("list-manager-workflow", managerFlow.role)),
    ).toBe(1);
    expect(
      valueOf(
        await collect(meters[1] ?? instanceMeter()),
        TIMEOUT_CHANGED,
        labelsOf("list-manager-workflow", managerFlow.role),
      ),
    ).toBe(1);
  });

  metered(
    "no label of any pause metric is an id, a tenant, a thread or a question",
    async ({ apps, meters }) => {
      const [first] = apps;
      if (first === undefined) throw new Error("an instance");
      await execute(
        first,
        managerFlow.start,
        { orderId: "secret-order", note: "bob@example.com" },
        { threadId: "pii-thread", tenant: { tenantId: "tenant-pii" } },
      );
      await first.resume(
        { pauseId: asked.sent[0]?.pauseId ?? "", decision: { approved: true } },
        { ...manager, tenantId: "tenant-pii" },
      );

      const seen = JSON.stringify(
        await Promise.all(meters.map(async (meter) => [...(await collect(meter)).values()])),
        (_key, value: unknown) => (value instanceof Map ? [...value] : value),
      );
      for (const secret of ["secret-order", "bob@example.com", "pii-thread", "tenant-pii"])
        expect(seen).not.toContain(secret);
      expect(seen).not.toContain(asked.sent[0]?.pauseId ?? "never");
    },
  );
});

describe("#943 AC2: the sites that close without a request", () => {
  const AT = new Date("2026-01-05T11:00:00.000Z");
  const SITE = { tenantId: "default", threadId: "thread-1", rootExecutionId: "run-1" };

  /** A tally that records what it was told. */
  function recording(): PauseTally & { readonly told: string[] } {
    const told: string[] = [];
    return {
      told,
      opened: (pause) => told.push(`opened ${pause.pauseId}`),
      closed: (pause) => told.push(`closed ${pause.pauseId} ${pause.resolution ?? "?"}`),
      timeoutChanged: (pause) => told.push(`timeout-changed ${pause.pauseId}`),
      reassigned: (pause) => told.push(`reassigned ${pause.pauseId}`),
      answerNotTaken: (pause) => told.push(`not-taken ${pause.pauseId} ${pause.resolution ?? "?"}`),
    };
  }

  function stores() {
    const tally = recording();
    const pauses = new InMemoryPausedExecutionRepository();
    const answers = new InMemoryExecutionRecordRepository(
      new VirtualClock(),
      new RandomIdGenerator(),
    );
    return {
      tally,
      pauses,
      seam: {
        pauses,
        answers,
        notices: { tally, recipientsOf: () => NO_RECIPIENTS, delivered: () => undefined },
      },
    };
  }

  it("a tree's end: a waiting pause closes tree-ended; an untaken answer is counted apart, not closed twice", async () => {
    const { tally, pauses, seam } = stores();
    await pauses.findOrCreateByStepKey(pauseOf("p-wait", "run-1:a:1:c1"));
    await pauses.findOrCreateByStepKey(pauseOf("p-answered", "run-1:a:1:c2"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-answered",
      APPROVED_BY_MANAGER,
      AT,
      NO_RECIPIENTS,
    );

    await closeTreePauses({ stores: seam }, SITE, { cause: new Error("failed") }, AT);

    expect(tally.told.sort()).toEqual([
      `closed p-wait ${PauseResolution.TreeEnded}`,
      `not-taken p-answered ${PauseResolution.TreeEnded}`,
    ]);
    // the same end again changes nothing: nothing is counted twice
    tally.told.length = 0;
    await closeTreePauses({ stores: seam }, SITE, { cause: new Error("failed") }, AT);
    expect(tally.told).toEqual([]);
  });

  it("a cancel closes cancelled; a withdrawn branch's pause closes withdrawn, once", async () => {
    const { tally, pauses, seam } = stores();
    await pauses.findOrCreateByStepKey(pauseOf("p-cancel", "run-1:a:1:c1"));
    await pauses.findOrCreateByStepKey(pauseOf("p-withdrawn", "run-1:a:1:c2"));

    await closeTreePauses({ stores: seam }, SITE, { cause: new ExecutionCancelledError() }, AT);
    const found = await pauses.findByTenantIdAndPauseId("default", "p-withdrawn");
    expect(found).toBeDefined();

    expect(tally.told.sort()).toEqual([
      `closed p-cancel ${PauseResolution.Cancelled}`,
      `closed p-withdrawn ${PauseResolution.Cancelled}`,
    ]);
    tally.told.length = 0;
    await pauses.findOrCreateByStepKey(pauseOf("p-w", "run-1:a:1:c3"));
    const record = await pauses.findByTenantIdAndPauseId("default", "p-w");
    if (record === undefined) throw new Error("the pause");
    expect(
      await withdrawPause(seam, record, { resolution: PauseResolution.Withdrawn, at: AT }),
    ).toBe(true);
    expect(
      await withdrawPause(seam, record, { resolution: PauseResolution.Withdrawn, at: AT }),
    ).toBe(false);
    expect(tally.told).toEqual([`closed p-w ${PauseResolution.Withdrawn}`]);
  });

  it("the reasons as labels: answered, withdrawn, cancelled, tree-ended, not-taken", async () => {
    const { provider, reader } = instanceMeter();
    const tally = pauseTallyOn(provider.getMeter("test"), { warn: vi.fn() } as never);
    const { pauses } = stores();
    const made = async (id: string, key: string) => {
      await pauses.findOrCreateByStepKey({ ...pauseOf(id, key), isSent: true });
    };
    await made("q1", "run-1:a:1:q1");
    await made("q2", "run-1:a:1:q2");
    await made("q3", "run-1:a:1:q3");
    await made("q4", "run-1:a:1:q4");
    const closed = [
      await pauses.cancelByTenantIdAndPauseId(
        "default",
        "q1",
        PauseResolution.Withdrawn,
        AT,
        NO_RECIPIENTS,
      ),
      await pauses.cancelByTenantIdAndPauseId(
        "default",
        "q2",
        PauseResolution.TreeEnded,
        AT,
        NO_RECIPIENTS,
      ),
      await pauses.resolveByTenantIdAndPauseId(
        "default",
        "q3",
        APPROVED_BY_MANAGER,
        AT,
        NO_RECIPIENTS,
      ),
    ];
    for (const record of closed) if (record !== undefined) tally.closed(record);
    const untaken = await pauses.closeUntakenByTenantIdAndPauseId(
      "default",
      "q3",
      PauseResolution.TreeEnded,
      AT,
      NO_RECIPIENTS,
    );
    if (untaken !== undefined) tally.answerNotTaken(untaken);

    const collected = await collect({ provider, reader });
    const reasons = (collected.get(CLOSED)?.points ?? []).map((point) => point.attributes.reason);
    expect(reasons.sort()).toEqual(["answered", "tree-ended", "withdrawn"]);
    expect(collected.get(NOT_TAKEN)?.points.map((point) => point.attributes)).toEqual([
      {
        workflow: "order-workflow",
        target: "refund-approval-channel",
        channel: "refund-approval-channel",
        reason: "tree-ended",
      },
    ]);
  });

  it("a counter that throws is a warning, never the pause's failure", () => {
    const failing = {
      add: () => {
        throw new Error("exporter down");
      },
    };
    const meter = {
      createCounter: () => failing,
      createHistogram: () => ({
        record: () => {
          throw new Error("exporter down");
        },
      }),
    } as never;
    const log = { warn: vi.fn() };
    const tally = pauseTallyOn(meter, log as never);
    const pause = {
      ...pauseOf("p", "k"),
      resolution: PauseResolution.Replied,
      resolvedAt: "2026-01-05T09:05:00.000Z",
    };

    expect(() => {
      tally.opened(pause);
      tally.closed(pause);
      tally.timeoutChanged(pause);
      tally.reassigned(pause);
    }).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      "metrics.pause-uncounted",
      expect.stringContaining("exporter down"),
    );
  });
});

describe("#943 AC2: the cluster gauges read the store", () => {
  metered(
    "notices waiting and dead are the store's counts at collection",
    async ({ apps, meters }) => {
      const [first] = apps;
      if (first === undefined) throw new Error("an instance");
      await execute(first, managerFlow.start, { orderId: "g", note: "n" }, { threadId: "g-1" });

      const collected = await collect(meters[0] ?? instanceMeter());

      expect(valueOf(collected, "agboss.cluster.pauses.notices.waiting")).toBeTypeOf("number");
      expect(valueOf(collected, "agboss.cluster.pauses.notices.dead")).toBe(0);
    },
  );
});
