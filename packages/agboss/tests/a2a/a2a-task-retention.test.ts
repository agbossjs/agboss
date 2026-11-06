/**
 * #807 AC5: the recovery sweep removes finished A2A tasks after `@Application({ a2a: {
 * taskRetention } })` — `hours(24)` by default — on the application's Clock, with their messages;
 * an unfinished task is never removed.
 */
import { describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import {
  A2ATaskRepository,
  A2ATaskState,
  type A2ATaskStatus,
} from "../../src/infrastructure/a2a-task.repository.js";
import { EmptyEnvironment } from "../../src/index.js";
import { testWith, type TestApp } from "../../src/testing/index.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { RecoveryWorkflow } from "../infrastructure/fixtures/recovery.workflow.js";
import { OrdersApplication } from "./fixtures/task.application.js";

@Application({
  name: "short-tasks-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  budgets: TEST_BUDGETS,
  a2a: { taskRetention: minutes(10) },
})
class ShortTasksApplication {}

/** Saves `taskId` accepted now and moves it to `status`. */
async function taskIn(app: TestApp, taskId: string, status: A2ATaskStatus): Promise<void> {
  await app.ready();
  const tasks = app.resolve(A2ATaskRepository);
  const acceptedAt = app.clock.now();
  await tasks.saveIfAbsent({
    tenantId: "default",
    taskId,
    ownerId: undefined,
    contextId: "ctx-1",
    skill: "order-workflow-start",
    status: { state: A2ATaskState.Submitted, pendingPauses: [] },
    acceptedAt,
    messageId: `m-${taskId}`,
    requestHash: "h",
  });
  await tasks.compareAndSetStatus({ tenantId: "default", taskId }, 1, status, acceptedAt);
}

const COMPLETED: A2ATaskStatus = { state: A2ATaskState.Completed, pendingPauses: [] };
const WORKING: A2ATaskStatus = { state: A2ATaskState.Working, pendingPauses: [] };
const find = (app: TestApp, taskId: string) =>
  app.resolve(A2ATaskRepository).findById({ tenantId: "default", taskId });

describe("#807 AC5: finished tasks are swept after their retention", () => {
  testWith(OrdersApplication)(
    "24 hours by default; an unfinished task stays",
    async ({ app, clock }) => {
      await taskIn(app, "done", COMPLETED);
      await taskIn(app, "running", WORKING);

      await clock.advance(hours(23));
      const kept = await find(app, "done");
      await clock.advance(hours(1));
      await clock.advance(seconds(31));

      expect(kept).toBeDefined();
      expect(await find(app, "done")).toBeUndefined();
      expect(await find(app, "running")).toBeDefined();
    },
  );

  testWith(ShortTasksApplication)("as the application sets it", async ({ app, clock }) => {
    await taskIn(app, "done", COMPLETED);

    await clock.advance(minutes(10));
    await clock.advance(seconds(31));

    expect(await find(app, "done")).toBeUndefined();
  });
});
