/**
 * #807 AC5, #1320: the recovery sweep removes finished A2A tasks after their endpoint's
 * `ttl.tasks` on the application's Clock, with their messages — each endpoint's own, so two
 * endpoints of one application keep their rows for their own time; `Ttl.Forever` keeps them for
 * ever; an unfinished task is never removed.
 */
import { describe, expect } from "vitest";
import { A2AEndpoint } from "../../src/a2a/a2a-endpoint.decorator.js";
import { Application } from "../../src/application/application.js";
import {
  A2ATaskRepository,
  A2ATaskState,
  type A2ATaskStatus,
} from "../../src/infrastructure/a2a-task.repository.js";
import { testWith, type TestApp } from "../../src/testing/index.js";
import { hours, minutes, seconds, Ttl } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  OrderWorkflowStart,
  RecoveryWorkflow,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

@A2AEndpoint({
  name: "short-tasks",
  version: "1.0.0",
  description: "Keeps its finished tasks ten minutes",
  ttl: { tasks: minutes(10), messages: minutes(15) },
  skills: [OrderWorkflowStart],
})
class ShortTasksEndpoint {}

@A2AEndpoint({
  name: "long-tasks",
  version: "1.0.0",
  description: "Keeps its finished tasks a day",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [OrderWorkflowStart],
})
class LongTasksEndpoint {}

@A2AEndpoint({
  name: "forever-tasks",
  version: "1.0.0",
  description: "Keeps its finished tasks for ever",
  ttl: { tasks: Ttl.Forever, messages: minutes(15) },
  skills: [OrderWorkflowStart],
})
class ForeverTasksEndpoint {}

@Application({
  name: "short-tasks-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [RecoveryWorkflow],
  budgets: TEST_BUDGETS,
  endpoints: [ShortTasksEndpoint, LongTasksEndpoint, ForeverTasksEndpoint],
})
class TasksApplication {}

/** Saves `taskId` of `endpoint` accepted now and moves it to `status`. */
async function taskIn(
  app: TestApp,
  endpoint: string,
  taskId: string,
  status: A2ATaskStatus,
): Promise<void> {
  await app.ready();
  const tasks = app.resolve(A2ATaskRepository);
  const acceptedAt = app.clock.now();
  await tasks.saveIfAbsent({
    endpoint,
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

describe("#807 AC5, #1320: finished tasks are swept after their endpoint's ttl", () => {
  testWith(TasksApplication)(
    "each endpoint at its own ttl; an unfinished task stays; Ttl.Forever is never swept",
    async ({ app, clock }) => {
      await taskIn(app, "short-tasks", "short-done", COMPLETED);
      await taskIn(app, "short-tasks", "short-running", WORKING);
      await taskIn(app, "long-tasks", "long-done", COMPLETED);
      await taskIn(app, "forever-tasks", "forever-done", COMPLETED);

      await clock.advance(minutes(10));
      await clock.advance(seconds(31));
      const afterShort = [
        await find(app, "short-done"),
        await find(app, "short-running"),
        await find(app, "long-done"),
        await find(app, "forever-done"),
      ].map((task) => task !== undefined);
      await clock.advance(hours(24));
      await clock.advance(seconds(31));
      const afterLong = [
        await find(app, "short-running"),
        await find(app, "long-done"),
        await find(app, "forever-done"),
      ].map((task) => task !== undefined);

      expect(afterShort).toEqual([false, true, true, true]);
      expect(afterLong).toEqual([true, false, true]);
    },
  );
});
