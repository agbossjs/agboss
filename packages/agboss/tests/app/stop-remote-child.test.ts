/**
 * #1341b — `app.stop` of a thread whose parent waits for a `ChildPlacement.AnyWorker` child that
 * another instance runs: `Immediate` aborts the child's step at the worker's next look (10 s of the
 * clock) and the parent resolves `Stopped` while the step's gate is still closed; `AfterStep` lets the
 * child's step in flight finish — the call is still waiting after the look — and nothing starts after
 * it. Nothing is cancelled or undone either way, and the record is `stopped`. The clock is the
 * test's `VirtualClock`.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/index.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { settle } from "./fixtures/fence-takeover.js";
import type { ItemDto } from "../flow/runtime/fixtures/fan-out.workflow.js";
import {
  openGate,
  RemoteChildYieldApplication,
  resetYield,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(RemoteChildYieldApplication, { instances: 2 });
const THREAD = "t-stop-remote-child";

const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });

beforeEach(resetYield);

/** Both instances, the second ready first: its worker claims what the first queues. */
async function bothReady(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [a, b] = apps;
  if (a === undefined || b === undefined) throw new Error("the test runs two instances");
  await b.ready();
  await a.ready();
  return [a, b];
}

/** `steps` times 10 s of the clock: every live holder renews and every worker looks on the way. */
async function liveFor(clock: VirtualClock, steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) await clock.advance(seconds(10));
}

const PENDING = Symbol("pending");
/** What `call` settled to, or `PENDING` when it has not settled yet. */
const settledOf = async (call: Promise<unknown>): Promise<unknown> => {
  await settle();
  return Promise.race([call, Promise.resolve(PENDING)]);
};

describe("#1341b: a stop of a parent whose child runs on another instance", () => {
  test("Immediate: the child's step is aborted at the worker's next look — the parent resolves Stopped with the gate still closed, nothing undone", async ({
    apps,
    clock,
  }) => {
    const [first, second] = await bothReady(apps);
    const call = execute(first, YieldOneWorkflowStart, item("gate"), { threadId: THREAD });
    call.catch(() => undefined);
    await until(() => yieldSeen.runs.length === 1, "the child at its gate");

    const asked = await second.stop(THREAD, { mode: InterruptMode.Immediate, reason: "enough" });
    await liveFor(clock, 3);

    expect(asked).toMatchObject({ state: "stopping" });
    await expect(call).resolves.toMatchObject({
      status: ExecutionStatus.Stopped,
      reason: "enough",
    });
    expect(yieldSeen.runs.map((run) => run.name)).toEqual(["gate"]);
    expect(await first.cancel(THREAD)).toEqual({ cancelled: false });
  });

  test("AfterStep: the child's step in flight is not aborted — the parent still waits after the look — and the run ends Stopped once the step returns", async ({
    apps,
    clock,
  }) => {
    const [first, second] = await bothReady(apps);
    const call = execute(first, YieldOneWorkflowStart, item("gate"), { threadId: THREAD });
    call.catch(() => undefined);
    await until(() => yieldSeen.runs.length === 1, "the child at its gate");

    await second.stop(THREAD, { reason: "wind down" });
    await liveFor(clock, 3);
    expect(await settledOf(call)).toBe(PENDING);

    openGate();
    await liveFor(clock, 3);

    await expect(call).resolves.toMatchObject({
      status: ExecutionStatus.Stopped,
      reason: "wind down",
    });
    expect(yieldSeen.runs.map((run) => run.name)).toEqual(["gate"]);
  });
});
