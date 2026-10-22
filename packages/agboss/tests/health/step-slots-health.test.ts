import { beforeEach, describe, expect } from "vitest";
import { HealthComponentKind, HealthStatus, type HealthReport } from "../../src/index.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetTreeLog, treeLog } from "../flow/runtime/fixtures/tree-task.workflow.js";
import { ItemsWorkflowStart, StepCapApplication } from "../app/fixtures/step-slots.workflow.js";
import { PlainProbeApplication } from "./fixtures/health.application.js";

/**
 * #332 AC4 — readiness reads the instance's step slots (`@Application({ maxConcurrentSteps })`):
 * the component `step-slots` is `Degraded` while every slot is busy (its reason: busy, of, waiting)
 * and `Healthy` once one frees; liveness never reads them; no cap → no component.
 */

const test = testWith(StepCapApplication, { concurrency: TestConcurrency.Real });
const plain = testWith(PlainProbeApplication);

/** The report's step slots, when it has them. */
const stepSlotsOf = (report: HealthReport): HealthReport["components"][number] | undefined =>
  report.components.find((component) => component.kind === HealthComponentKind.StepSlots);

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
  test("Degraded while all 4 are busy, Healthy once one frees; liveness stays Healthy", async ({
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

    expect(stepSlotsOf(idle)).toEqual({
      name: "step-slots",
      kind: HealthComponentKind.StepSlots,
      status: HealthStatus.Healthy,
      duration: 0,
    });
    expect(stepSlotsOf(busy)).toEqual({
      name: "step-slots",
      kind: HealthComponentKind.StepSlots,
      status: HealthStatus.Degraded,
      reason: "4 of 4 step slots busy, 3 steps waiting",
      duration: 0,
    });
    expect(busy.status).toBe(HealthStatus.Degraded);
    expect(live.status).toBe(HealthStatus.Healthy);
    expect(stepSlotsOf(live)).toBeUndefined();
    expect(stepSlotsOf(freed)?.status).toBe(HealthStatus.Healthy);
  });
});

describe("#332: no cap, no component", () => {
  plain("an application without maxConcurrentSteps reports no step slots", async ({ app }) => {
    const report = await app.checkReadiness();

    expect(stepSlotsOf(report)).toBeUndefined();
  });
});
