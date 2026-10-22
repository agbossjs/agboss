import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError, EmptyEnvironment } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  BatchDoneWorkflowFinish,
  BatchWorkflowStart,
} from "../flow/runtime/fixtures/tree-batch.workflow.js";
import {
  resetTreeLog,
  treeLog,
  untilLogged,
  type TaskDto,
} from "../flow/runtime/fixtures/tree-task.workflow.js";
import {
  ItemsWorkflow,
  ItemsWorkflowStart,
  SingleStepApplication,
  StepCapApplication,
  StepCapRecoveryApplication,
} from "./fixtures/step-slots.workflow.js";

/**
 * #332 AC1 / AC2 / Q4 — `@Application({ maxConcurrentSteps })` on whole applications: a launch of 20
 * actions under a cap of 4 never runs more than 4, two executions share the cap, a tree of children
 * under a cap of 1 finishes (no deadlock), an invalid cap fails assembly, and the steps waiting in
 * the instance's queue at its stop are interrupted with the running ones and recovered elsewhere.
 */

const REAL = { concurrency: TestConcurrency.Real };
const test = testWith(StepCapApplication, REAL);
const single = testWith(SingleStepApplication, REAL);
const instances = testWith(StepCapRecoveryApplication, { ...REAL, instances: 2 });

const tasks = (count: number, prefix = "t", wait = 10): TaskDto[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `${prefix}${String(index)}`,
    seconds: wait,
    outcome: "ok",
  }));

/** How many tasks started so far. */
const started = (): number => treeLog.events.filter((event) => event.startsWith("start ")).length;

/** Resolves once `count` tasks have started. */
async function untilStarted(count: number): Promise<void> {
  for (let tick = 0; started() < count; tick += 1) {
    if (tick > 200_000) throw new Error(`only ${String(started())} of ${String(count)} started`);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

beforeEach(() => {
  resetTreeLog();
  resetRecovery();
});

describe("AC1: never more than maxConcurrentSteps steps at once", () => {
  test("20 actions of one launch under a cap of 4: 4 at a time, all 20 finish", async ({
    app,
    clock,
  }) => {
    const execution = execute(app, ItemsWorkflowStart, tasks(20));
    for (let batch = 1; batch <= 5; batch += 1) {
      await untilStarted(batch * 4);
      await clock.advance(seconds(10));
    }
    const result = await execution;

    expect(treeLog.mostWorking).toBe(4);
    expect(result).toFinishWith(BatchDoneWorkflowFinish, {
      name: tasks(20)
        .map((task) => task.name)
        .join(", "),
    });
  });

  test("two executions share the instance's cap", async ({ app, clock }) => {
    const first = execute(app, ItemsWorkflowStart, tasks(3, "a"));
    const second = execute(app, ItemsWorkflowStart, tasks(3, "b"));
    await untilStarted(4);
    await clock.advance(seconds(10));
    await untilStarted(6);
    await clock.advance(seconds(10));
    await Promise.all([first, second]);

    expect(treeLog.mostWorking).toBe(4);
    expect(started()).toBe(6);
  });
});

describe("AC2: no deadlock", () => {
  single(
    "a tree of child workflows under a cap of 1 finishes, one step at a time",
    async ({ app, clock }) => {
      const execution = execute(app, BatchWorkflowStart, tasks(3, "c", 1));
      for (let count = 1; count <= 3; count += 1) {
        await untilStarted(count);
        await clock.advance(seconds(1));
      }
      const result = await execution;

      expect(treeLog.mostWorking).toBe(1);
      expect(result).toFinishWith(BatchDoneWorkflowFinish, { name: "c0, c1, c2" });
    },
  );
});

describe("AC1: the cap is a whole number of steps from 1", () => {
  const capped = (maxConcurrentSteps: number): unknown => {
    @Application({
      name: "invalid-cap-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [ItemsWorkflow],
      budgets: TEST_BUDGETS,
      maxConcurrentSteps,
    })
    class InvalidCapApplication {}
    return applicationOf(InvalidCapApplication);
  };

  test.each([0, -1, 2.5])("maxConcurrentSteps %s fails assembly", async (value) => {
    await expect(capped(value)).rejects.toThrow(
      `[limits.max-concurrent-steps-invalid] its maxConcurrentSteps is ${String(value)}, not a whole number of steps from 1`,
    );
  });
});

describe("Q4: the steps waiting at the instance's stop", () => {
  instances(
    "are interrupted at the shutdown timeout with the running ones; the other instance recovers them",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      const items: TaskDto[] = [
        { name: "hold", seconds: 0, outcome: "hold" },
        { name: "a", seconds: 0, outcome: "ok" },
        { name: "c", seconds: 0, outcome: "ok" },
      ];
      const call = execute(instance(apps, 0), ItemsWorkflowStart, items);
      call.catch(() => undefined);
      await untilLogged("start hold");

      const closed = instance(apps, 0).close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;
      await clock.advance(seconds(30));
      const [recovered] = await ends(1);

      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      // a and c waited in the instance's queue behind hold when it stopped
      expect(treeLog.events).toEqual([
        "start hold",
        "start hold",
        "end hold",
        "start a",
        "end a",
        "start c",
        "end c",
      ]);
      expect(treeLog.mostWorking).toBe(1);
      expect(recovered?.output).toEqual({ name: "hold, a, c" });
    },
  );
});
