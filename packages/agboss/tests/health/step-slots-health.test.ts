import { beforeEach, describe, expect } from "vitest";
import { HealthStatus } from "../../src/index.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetTreeLog, treeLog } from "../flow/runtime/fixtures/tree-task.workflow.js";
import { ItemsWorkflowStart, StepCapApplication } from "../app/fixtures/step-slots.workflow.js";
import { PlainProbeApplication } from "./fixtures/health.application.js";

/**
 * #332 AC4 — readiness reads the instance's step slots (`@Application({ maxConcurrentSteps })`):
 * `isBusy` is true while every slot is busy (and `isReady` false), clear once one frees; `status`
 * is not touched; no cap → never busy.
 */

const test = testWith(StepCapApplication, { concurrency: TestConcurrency.Real });
const plain = testWith(PlainProbeApplication);

/** Resolves once `count` tasks are at work. */
async function untilWorking(count: number): Promise<void> {
  for (let tick = 0; treeLog.working < count; tick += 1) {
    if (tick > 200_000) throw new Error(`only ${String(treeLog.working)} at work`);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

const tasks = (count: number, wait: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `t${String(index)}`,
    seconds: wait,
    outcome: "ok",
  }));

beforeEach(resetTreeLog);

describe("#332 AC4: the step slots in readiness", () => {
  test("isBusy while all 4 are busy, clear once one frees; status and liveness are not touched", async ({
    app,
    clock,
  }) => {
    const idle = await app.checkReadiness();
    // four for 10 s, a fifth for 20 s, two more waiting behind them
    const execution = execute(app, ItemsWorkflowStart, [...tasks(4, 10), ...tasks(3, 20)]);
    await untilWorking(4);
    const busy = await app.checkReadiness();
    const live = await app.checkLiveness();
    await clock.advance(seconds(10));
    await clock.advance(seconds(20));
    await execution;
    const freed = await app.checkReadiness();

    expect(idle).toMatchObject({ isBusy: false, isAlive: true, isReady: true });
    expect(busy).toMatchObject({
      status: HealthStatus.Healthy,
      isBusy: true,
      isAlive: true,
      isReady: false,
    });
    expect(live).toMatchObject({ status: HealthStatus.Healthy, isBusy: true, isReady: false });
    expect(busy.components.map((component) => component.kind)).not.toContain("step-slots");
    expect(freed).toMatchObject({ isBusy: false, isReady: true });
  });
});

describe("#332: no cap, never busy", () => {
  plain("an application without maxConcurrentSteps is never busy", async ({ app }) => {
    const report = await app.checkReadiness();

    expect(report).toMatchObject({ isBusy: false, isAlive: true, isReady: true });
  });
});
