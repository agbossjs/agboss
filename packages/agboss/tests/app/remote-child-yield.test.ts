/**
 * #516 — a parent waiting for its `ChildPlacement.AnyInstance` children yields its lease in the
 * store, where every instance sees it: still held, still renewed. Another instance's recovery sweep
 * takes over nothing while the holder lives (AC1); a dead holder's tree is recovered there (AC2); a
 * pause answered on the other instance while the parent waits resumes (AC3); a cancel during the
 * yield ends the tree.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ExecutionCancelledError,
  ExecutionLeaseEventKind,
  ExecutionLeaseLostError,
  ExecutionLeaseRepository,
  ExecutionStatus,
  LeaseTakeoverReason,
} from "../../src/index.js";
import { replyWith, callTool, testWith, type ModelRequest } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { settle } from "./fixtures/fence-takeover.js";
import {
  ItemResultDto,
  SummaryWorkflowFinish,
  type ItemDto,
} from "../flow/runtime/fixtures/fan-out.workflow.js";
import {
  ConfirmItemTool,
  openGate,
  RemoteChildYieldApplication,
  resetYield,
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  YieldReviewerAgent,
  YieldReviewsWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(RemoteChildYieldApplication, { instances: 2 });

const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });

/** Both instances, the second ready first: its worker claims what the first queues. */
async function bothReady(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [a, b] = apps;
  if (a === undefined || b === undefined) throw new Error("the test runs two instances");
  await b.ready();
  await a.ready();
  return [a, b];
}

/** The takeovers of the root's own lease in its tree's lease log, but its holders' reclaims. */
async function takeoversOf(app: TestApp, rootExecutionId: string): Promise<readonly unknown[]> {
  const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId });
  return rows.filter(
    (row) =>
      row.kind === ExecutionLeaseEventKind.Takeover &&
      row.executionId === rootExecutionId &&
      row.reason !== LeaseTakeoverReason.Reacquired,
  );
}

/** The root's executions that started and ended, by their workflow's name. */
const rootsOf = (lines: readonly string[]): readonly string[] =>
  lines
    .filter((line) => line.startsWith("yield-one-workflow "))
    .map((line) => line.split(" ")[1] ?? "");

/** The item a review child reads (its input message). */
const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

/** The reviewer: confirms an `ask…` item first, answers every other at once. */
const reviewer = (request: ModelRequest) => {
  const name = nameIn(request);
  const isConfirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return name.startsWith("ask") && !isConfirmed
    ? callTool(ConfirmItemTool, { name })
    : replyWith(ItemResultDto, { name });
};

/** `steps` times 10 s of the clock: every live holder renews on the way, none freezes. */
async function liveFor(clock: VirtualClock, steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) await clock.advance(seconds(10));
}

beforeEach(() => {
  resetYield();
  resetLogged();
});

describe("#516 AC1: a parent waiting for AnyInstance children is not taken over", () => {
  test("AC1: two instances — the caller of execute gets the finished output, and no sweep of the other instance takes the tree over", async ({
    apps,
    clock,
  }) => {
    const [a, b] = await bothReady(apps);
    const call = execute(a, YieldOneWorkflowStart, item("gate"));
    await until(() => yieldSeen.runs.length === 1, "the child at its gate");
    const [root] = rootsOf(yieldSeen.starts);

    // what every instance sees in the store: the waiting parent's tree is held
    const seenByOther = await b
      .resolve(ExecutionLeaseRepository)
      .acquire("default", root ?? "", seconds(30));
    // three sweeps of every instance while the parent waits, every holder alive (renewing)
    await liveFor(clock, 10);
    openGate();
    const done = await call;

    expect(seenByOther).toBeUndefined();
    expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "gate" });
    expect(done.executionId).toBe(root);
    expect(yieldSeen.runs.map((run) => run.name)).toEqual(["gate"]);
    expect(rootsOf(yieldSeen.starts)).toEqual([done.executionId]);
    expect(rootsOf(yieldSeen.ends)).toEqual([done.executionId]);
    expect(await takeoversOf(a, done.executionId)).toEqual([]);
    expect(logged.filter((entry) => entry.code === "execution.recovered")).toEqual([]);
  });
});

describe("#516 AC2: the holder dies while the parent waits", () => {
  test("AC2: the holder dies while waiting → recovered once on the other instance, the child run once", async ({
    apps,
    clock,
    leases,
  }) => {
    const [a, b] = await bothReady(apps);
    const call = execute(a, YieldOneWorkflowStart, item("gate"));
    await until(() => yieldSeen.runs.length === 1, "the child at its gate");

    leases.stall(a);
    await liveFor(clock, 7);
    await until(
      () => logged.some((entry) => entry.code === "execution.recovered"),
      "the other instance's recovery",
    );
    openGate();
    await until(() => rootsOf(yieldSeen.ends).length === 1, "the recovered tree's end");
    leases.resume(a);

    await expect(call).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    const [root] = rootsOf(yieldSeen.starts);
    expect(rootsOf(yieldSeen.starts)).toHaveLength(1);
    expect(rootsOf(yieldSeen.ends)).toEqual([root]);
    // instances are named in the order they start: `b`, ready first, is instance-1
    expect(yieldSeen.runs).toEqual([{ name: "gate", instanceId: "instance-1" }]);
    expect(await takeoversOf(b, root ?? "")).toMatchObject([
      {
        reason: LeaseTakeoverReason.Recovered,
        holderInstanceId: "instance-1",
        previousHolderInstanceId: "instance-2",
      },
    ]);
  });
});

describe("#516 AC3: a pause answered on the other instance while the parent waits", () => {
  test("AC3: a pause answered on the other instance while the parent waits still resumes, and both calls get the finished output", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(YieldReviewerAgent).thenAnswer(reviewer);
    const [a, b] = await bothReady(apps);
    const call = execute(a, YieldReviewsWorkflowStart, [item("ask"), item("gate")]);
    await until(
      () => yieldSeen.pauseIds.length === 1 && yieldSeen.runs.some(({ name }) => name === "gate"),
      "one child paused, the other at its gate",
    );

    const answer = { pauseId: yieldSeen.pauseIds[0] ?? "", decision: { approved: true } };
    const resumed = b.resume(answer, { tenantId: "default" });
    await settle();
    openGate();
    const [done, answered] = await Promise.all([call, resumed]);

    expect(done).toFinishWith(SummaryWorkflowFinish, { text: "ask, gate" });
    expect(answered.status).toBe(ExecutionStatus.Finished);
    expect(answered.executionId).toBe(done.executionId);
    expect(mockLlm(YieldReviewerAgent).requests.map(nameIn)).toEqual(["ask", "gate", "ask"]);
    expect(await takeoversOf(a, done.executionId)).toEqual([]);
  });
});

describe("#516: a cancel while the parent waits", () => {
  test("a cancel asked on the other instance during the yield stops the waiting parent at its next renewal", async ({
    apps,
    clock,
  }) => {
    const [a, b] = await bothReady(apps);
    const call = execute(a, YieldOneWorkflowStart, item("gate"), { threadId: "thread-cancel" });
    await until(() => yieldSeen.runs.length === 1, "the child at its gate");

    const cancelled = await b.cancel("thread-cancel", { tenantId: "default" });
    await clock.advance(seconds(11));

    expect(cancelled).toEqual({ cancelled: true });
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    openGate();
  });
});
