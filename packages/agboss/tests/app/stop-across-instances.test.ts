/**
 * #1341b: `app.stop(threadId)` on any instance stops the thread's execution wherever it runs — an
 * `Immediate` stop within one lease renewal, an `AfterStep` stop after the step in flight —, its
 * caller resolves `Stopped`, nothing is undone, and a stop asked again changes nothing.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/index.js";
import { InterruptMode, StopRequestState } from "../../src/app/interrupt-types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  Hold,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  RecoveryApplication,
  resetRecovery,
  seen,
  Step,
  stores,
} from "../infrastructure/fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication, { instances: 2 });
const THREAD = "t-stop";

beforeEach(resetRecovery);

async function pair(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

/** Starts an execution on `app` that steps and then holds; resolves once it holds. */
async function holding(app: TestApp): Promise<{ readonly call: Promise<unknown> }> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const call = execute(app, OrderWorkflowStart, { text: "step, then hold" }, { threadId: THREAD });
  call.catch(() => undefined);
  await held;
  return { call };
}

const lastStatus = async (): Promise<string | undefined> =>
  ((await stores.records?.lastTurns("default", THREAD, 1)) ?? [])[0]?.status;

const stepAndHold = [
  callTool(Step, { text: "one" }),
  callTool(Hold, { text: "a long job" }),
] as const;

describe("#1341b: a stop on the other instance", () => {
  test("Immediate: within one renewal the holder's call resolves Stopped, nothing is cancelled or undone, the record is `stopped`", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);

    const asked = await second.stop(THREAD, { mode: InterruptMode.Immediate, reason: "enough" });
    await clock.advance(seconds(10));

    expect(asked).toEqual({ state: StopRequestState.Stopping });
    await expect(call).resolves.toMatchObject({
      status: ExecutionStatus.Stopped,
      reason: "enough",
    });
    expect(seen.cancels).toEqual([]);
    expect(seen.stops).toHaveLength(1);
    expect(seen.errors).toEqual([]);
    expect(seen.steps).toEqual(["one"]);
    expect(await lastStatus()).toBe("stopped");
    expect(await second.stop(THREAD)).toEqual({ state: StopRequestState.NotRunning });
    expect(await first.cancel(THREAD)).toEqual({ cancelled: false });
  });

  test("AfterStep: the step in flight is not aborted; once it returns no step starts, the call resolves Stopped", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold, replyWith(ReceiptDto, { text: "done" }));
    const [first, second] = await pair(apps);
    const { call } = await holding(first);

    await second.stop(THREAD, { reason: "wind down" });
    await clock.advance(seconds(10));
    levers.letGo?.();

    await expect(call).resolves.toMatchObject({
      status: ExecutionStatus.Stopped,
      reason: "wind down",
    });
    expect(seen.holds).toHaveLength(1);
    expect(await lastStatus()).toBe("stopped");
  });

  test("a stop asked twice writes its request once and ends the execution once", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);

    await second.stop(THREAD, { mode: InterruptMode.Immediate });
    await first.stop(THREAD, { mode: InterruptMode.Immediate });
    await clock.advance(seconds(10));

    await expect(call).resolves.toMatchObject({ status: ExecutionStatus.Stopped });
    expect(seen.stops).toHaveLength(1);
  });
});
