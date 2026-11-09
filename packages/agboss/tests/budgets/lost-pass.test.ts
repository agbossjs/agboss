/**
 * #853 — a model call sent by a pass that dies before its answer leaves an Unknown-cost entry: the
 * recovery that runs the step again records one ledger entry for the lost pass (cost source
 * `Unknown`, no amount), keyed by (execution, step, pass) — never by who finds it —, and the spend
 * report counts it next to the known total. A clean run, and a recovery whose lost pass had
 * finished the step, record none.
 */
import { beforeEach, describe, expect } from "vitest";
import { BudgetPeriod, BudgetScope, CostSource, type LedgerEntry } from "../../src/index.js";
import { counterOf } from "../../src/budgets/execution-budgets.js";
import { ModelFailure } from "../../src/models/model-failure.js";
import {
  failWith,
  replyWith,
  testWith,
  waitFor,
  type VirtualClock,
} from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { TestLeases } from "../../src/testing/leases.js";
import { hours, seconds, usd } from "../../src/units/index.js";
import { until } from "../helpers/until.js";
import { collect, instanceMeters } from "../metrics/support/metric-reader.js";
import { execute } from "../helpers/flow.js";
import { instance } from "../app/fixtures/fence-takeover.js";
import {
  CheckDto,
  CheckerAgent,
  DrafterAgent,
  LostBranchWorkflowStart,
  LostPassApplication,
  LostPassWorkflowStart,
  lostPassLevers,
  lostPassSeen,
  ReportDto,
  resetLostPass,
  ReviewerAgent,
  sharedSpentOf,
  WriterAgent,
} from "./fixtures/lost-pass.application.js";

const one = testWith(LostPassApplication);
const two = testWith(LostPassApplication, { instances: 2 });
const three = testWith(LostPassApplication, { instances: 3 });
const meters = instanceMeters(2);
const meteredTwo = testWith(LostPassApplication, {
  instances: meters.map((meter) => ({ meterProvider: meter.provider })),
});

/** `agboss.instance.costs.unknown` of the workflow, summed over the instances' meters (#875). */
async function unknownCostsCounted(): Promise<number> {
  let sum = 0;
  for (const meter of meters) {
    const points = (await collect(meter)).get("agboss.instance.costs.unknown")?.points ?? [];
    for (const point of points) sum += point.value;
  }
  return sum;
}

beforeEach(() => {
  resetLostPass();
});

const unknownOf = (entries: readonly LedgerEntry[]): readonly LedgerEntry[] =>
  entries.filter((entry) => entry.costSource === CostSource.Unknown);

/** The distinct ids of the Unknown entries the ledger was handed. */
const unknownIdsOf = (entries: readonly LedgerEntry[]): readonly string[] => [
  ...new Set(unknownOf(entries).map((entry) => entry.ledgerId)),
];

/** What the application's daily budget holds now. */
const applicationSpent = (clock: VirtualClock) =>
  sharedSpentOf(
    counterOf(
      {
        budget: { name: "test-application-daily-budget" },
        scope: BudgetScope.Application,
        key: "lost-pass-application",
        maxSpend: 1000,
        period: BudgetPeriod.Day,
      },
      clock.now(),
    ),
  );

/** The instance (of `apps`) that took the tree over last, from the lease log. */
async function takerOf(apps: readonly TestApp[], rootExecutionId: string): Promise<TestApp> {
  const rows = await instance(apps, 0).leaseEventsOf({ tenantId: "default", rootExecutionId });
  const holder = rows.at(-1)?.holderInstanceId ?? "";
  const index = Number(holder.replace("instance-", "")) - 1;
  return instance(apps, index);
}

/** Freezes `holder`'s lease and moves the clock past it and a sweep: another instance takes over. */
async function loseLease(holder: TestApp, clock: VirtualClock, leases: TestLeases): Promise<void> {
  leases.freeze(holder);
  // in steps shorter than a lease: the other instances' own leases are renewed meanwhile (#534)
  for (let step = 0; step < 7; step += 1) await clock.advance(seconds(10));
}

/** Every instance started (its sweep running), then the execution on `app`, its model call under way. */
async function startedOn(app: TestApp, apps: readonly TestApp[]): Promise<void> {
  for (const each of apps) await each.ready();
  const call = execute(app, LostPassWorkflowStart, { text: "write it" });
  call.catch(() => undefined);
  await until(() => lostPassSeen.modelCalls >= 1, "the model call under way");
}

describe("#853: a lost pass of a step leaves one Unknown-cost entry", () => {
  two(
    "AC1: kill -9 during a model call, then a takeover → one Unknown entry for that pass, the re-run's cost counted once",
    async ({ apps, clock, leases, mockLlm }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      // a model step after the lost one, in the re-run's later supersteps: never a lost pass
      mockLlm(ReviewerAgent).thenReturnAlways(replyWith(ReportDto, { text: "reviewed" }));
      mockLlm(WriterAgent).thenReturn(
        waitFor(hours(2)),
        replyWith(ReportDto, { text: "never heard" }),
        replyWith(ReportDto, { text: "done" }, { cost: usd(0.01) }),
      );
      await startedOn(a, apps);

      await loseLease(a, clock, leases);
      await until(() => lostPassSeen.ends.length === 1, "the recovered execution's end");

      const unknown = unknownOf(lostPassSeen.saved);
      expect(unknownIdsOf(lostPassSeen.saved)).toHaveLength(1);
      const [entry] = unknown;
      expect(entry?.costUsd).toBe(0);
      expect(entry?.caller).toContain("writer-agent");
      // keyed by the pass that was lost (token 1), not by the instance that found it
      expect(entry?.ledgerId).toMatch(/^unknown:.+:writer-agent:.+:1$/);
      // the re-run's real cost, once; the Unknown entry adds nothing
      expect(await applicationSpent(clock)).toBe(0.01);
      const [report] = lostPassSeen.ends;
      expect(report?.totalUsd).toBe(0.01);
      // the writer's re-run and the reviewer: the calls of known cost
      expect(report?.calls).toBe(2);
      expect(report?.unknownCalls).toBe(1);
      leases.thaw(a);
    },
  );

  one("AC2: a clean run records no Unknown entry", async ({ app, mockLlm, clock }) => {
    // a model step after the lost one, in the re-run's later supersteps: never a lost pass
    mockLlm(ReviewerAgent).thenReturnAlways(replyWith(ReportDto, { text: "reviewed" }));
    mockLlm(WriterAgent).thenReturn(replyWith(ReportDto, { text: "done" }, { cost: usd(0.01) }));

    await execute(app, LostPassWorkflowStart, { text: "write it" });

    expect(unknownOf(lostPassSeen.saved)).toEqual([]);
    expect(lostPassSeen.ends[0]?.unknownCalls).toBe(0);
    expect(await applicationSpent(clock)).toBe(0.01);
  });

  two(
    "AC2: a recovery whose lost pass had finished the step records no Unknown entry",
    async ({ apps, clock, leases, mockLlm }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      // a model step after the lost one, in the re-run's later supersteps: never a lost pass
      mockLlm(ReviewerAgent).thenReturnAlways(replyWith(ReportDto, { text: "reviewed" }));
      mockLlm(WriterAgent).thenReturn(replyWith(ReportDto, { text: "done" }, { cost: usd(0.01) }));
      lostPassLevers.isHolding = true;
      for (const each of apps) await each.ready();
      const call = execute(a, LostPassWorkflowStart, { text: "write it" });
      call.catch(() => undefined);
      await until(() => lostPassSeen.holds === 1, "the hold after the agent");

      await loseLease(a, clock, leases);
      await until(() => lostPassSeen.ends.length === 1, "the recovered execution's end");

      expect(lostPassSeen.holds).toBe(2);
      expect(unknownOf(lostPassSeen.saved)).toEqual([]);
      expect(lostPassSeen.ends[0]?.unknownCalls).toBe(0);
      expect(await applicationSpent(clock)).toBe(0.01);
      leases.thaw(a);
      lostPassLevers.letGo?.();
    },
  );

  two(
    "AC2: of one superstep, only the step the lost pass had not finished gets an Unknown entry",
    async ({ apps, clock, leases, mockLlm }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      mockLlm(DrafterAgent).thenReturn(
        replyWith(ReportDto, { text: "draft" }, { cost: usd(0.01) }),
      );
      mockLlm(CheckerAgent).thenReturn(
        waitFor(hours(2)),
        replyWith(CheckDto, { verdict: "never heard" }),
        replyWith(CheckDto, { verdict: "fine" }, { cost: usd(0.02) }),
      );
      for (const each of apps) await each.ready();
      const call = execute(a, LostBranchWorkflowStart, { text: "write it" });
      call.catch(() => undefined);
      await until(() => lostPassSeen.modelCalls === 2, "both model calls under way");
      // the drafter's answer is written at the superstep's checkpoint before the lease is lost
      await until(
        () => lostPassSeen.saved.some((entry) => entry.caller.includes("drafter")),
        "the drafter's spend",
      );

      await loseLease(a, clock, leases);
      await until(() => lostPassSeen.ends.length === 1, "the recovered execution's end");

      const ids = unknownIdsOf(lostPassSeen.saved);
      expect(ids).toHaveLength(1);
      expect(ids[0]).toContain(":checker-agent:");
      expect(await applicationSpent(clock)).toBeCloseTo(0.03, 10);
      expect(lostPassSeen.ends[0]?.unknownCalls).toBe(1);
      leases.thaw(a);
    },
  );

  three(
    "AC2: two recoveries of one lost pass write one entry for it; the re-run that is lost too gets its own",
    async ({ apps, clock, leases, mockLlm }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("three instances");
      // a model step after the lost one, in the re-run's later supersteps: never a lost pass
      mockLlm(ReviewerAgent).thenReturnAlways(replyWith(ReportDto, { text: "reviewed" }));
      mockLlm(WriterAgent).thenReturn(
        waitFor(hours(2)),
        replyWith(ReportDto, { text: "never heard" }),
        waitFor(hours(2)),
        replyWith(ReportDto, { text: "never heard either" }),
        replyWith(ReportDto, { text: "done" }, { cost: usd(0.01) }),
      );
      await startedOn(a, apps);

      // the first re-run is lost too, mid call, once it recorded the first lost pass
      await loseLease(a, clock, leases);
      await until(() => lostPassSeen.modelCalls === 2, "the first re-run's model call");
      await until(() => unknownIdsOf(lostPassSeen.saved).length === 1, "the first entry");
      const [first] = unknownOf(lostPassSeen.saved);
      const root = first?.ledgerId.split(":")[1] ?? "";
      const taker = await takerOf(apps, root);
      await loseLease(taker, clock, leases);
      await until(() => lostPassSeen.ends.length === 1, "the second re-run's end");

      const ids = unknownIdsOf(lostPassSeen.saved);
      expect(ids).toHaveLength(2);
      expect(ids.map((id) => id.split(":").at(-1))).toEqual(["1", "2"]);
      // the first lost pass was handed the ledger by both re-runs: one entry
      const firstId = ids[0] ?? "";
      expect(unknownOf(lostPassSeen.saved).filter((e) => e.ledgerId === firstId).length).toBe(2);
      expect(await applicationSpent(clock)).toBe(0.01);
      const [report] = lostPassSeen.ends;
      expect(report?.unknownCalls).toBe(2);
      expect(report?.totalUsd).toBe(0.01);
      leases.thaw(a);
      leases.thaw(taker);
    },
  );
});

describe("#875: the metric counts a lost pass whatever the execution's end", () => {
  meteredTwo(
    "AC1: a recovery whose re-run fails still counts its Unknown entry",
    async ({ apps, clock, leases, mockLlm }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      const before = await unknownCostsCounted();
      mockLlm(ReviewerAgent).thenReturnAlways(replyWith(ReportDto, { text: "reviewed" }));
      mockLlm(WriterAgent)
        .thenReturn(waitFor(hours(2)), replyWith(ReportDto, { text: "never heard" }))
        .thenReturnAlways(failWith(ModelFailure.ServerError));
      await startedOn(a, apps);

      await loseLease(a, clock, leases);
      await until(() => lostPassSeen.failures === 1, "the recovered execution's failure");

      expect(lostPassSeen.ends).toEqual([]);
      expect(unknownIdsOf(lostPassSeen.saved)).toHaveLength(1);
      expect((await unknownCostsCounted()) - before).toBe(1);
      leases.thaw(a);
    },
  );

  meteredTwo(
    "AC1: a recovery cancelled during its re-run still counts its Unknown entry",
    async ({ apps, clock, leases, mockLlm }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      const before = await unknownCostsCounted();
      mockLlm(ReviewerAgent).thenReturnAlways(replyWith(ReportDto, { text: "reviewed" }));
      mockLlm(WriterAgent).thenReturn(
        waitFor(hours(2)),
        replyWith(ReportDto, { text: "never heard" }),
        waitFor(hours(2)),
        replyWith(ReportDto, { text: "cancelled before it" }),
      );
      for (const each of apps) await each.ready();
      const call = execute(a, LostPassWorkflowStart, { text: "write it" }, { threadId: "t-875" });
      call.catch(() => undefined);
      await until(() => lostPassSeen.modelCalls >= 1, "the model call under way");

      await loseLease(a, clock, leases);
      await until(() => lostPassSeen.modelCalls >= 2, "the re-run's model call under way");
      expect(await instance(apps, 1).cancel("t-875")).toEqual({ cancelled: true });
      await until(() => lostPassSeen.failures === 1, "the cancelled execution's end");

      expect(lostPassSeen.ends).toEqual([]);
      expect((await unknownCostsCounted()) - before).toBe(1);
      leases.thaw(a);
    },
  );
});
