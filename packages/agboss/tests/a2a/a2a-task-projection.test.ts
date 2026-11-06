/**
 * #807 (A2A P1, design §4.1.3 step 7): an application that exposes an `@A2AExpose` moves each A2A
 * task with its execution's events — start → WORKING, a rest at a pause → INPUT_REQUIRED with the
 * pause, resume → WORKING, a finish → COMPLETED with its output, a failure → FAILED with its code (and
 * that code's fixed text, never the error's own), a
 * cancel → CANCELED — on whichever instance runs the pass; executions that are no task, and
 * applications that expose none, write nothing. A status the events missed is repaired on read.
 */
import { beforeEach, describe, expect } from "vitest";
import { executionControlOf, type ExecutionControl } from "../../src/app/execution-control.js";
import { withReservedExecutionId } from "../../src/app/tree-control.js";
import { repairedTask } from "../../src/a2a/tasks/a2a-task-repair.js";
import {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2ATaskRecord,
} from "../../src/infrastructure/a2a-task.repository.js";
import { PauseKind } from "../../src/pause/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
  Step,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { InternalOrdersApplication, OrdersApplication } from "./fixtures/task.application.js";

const exposed = testWith(OrdersApplication, { instances: 2 });
const internal = testWith(InternalOrdersApplication);

const TASK = "task-1";
const KEY = { tenantId: "default", taskId: TASK };
const done = replyWith(ReceiptDto, { text: "Done." });

beforeEach(resetRecovery);

/** Accepts the task on `app`'s store, as a server does before it starts the execution. */
async function accepted(app: TestApp): Promise<A2ATaskRecord> {
  await app.ready();
  const save = await app.resolve(A2ATaskRepository).saveIfAbsent({
    tenantId: "default",
    taskId: TASK,
    ownerId: undefined,
    contextId: "ctx-1",
    skill: "order-workflow-start",
    status: { state: A2ATaskState.Submitted, pendingPauses: [] },
    acceptedAt: app.clock.now(),
    messageId: "m-1",
    requestHash: "h-1",
  });
  if (save.status !== A2ATaskSaveStatus.Saved) throw new Error(save.status);
  return save.task;
}

const run = (app: TestApp, text = "go") =>
  execute(app, OrderWorkflowStart, { text }, withReservedExecutionId({ threadId: "ctx-1" }, TASK));

const taskOn = (app: TestApp) => app.resolve(A2ATaskRepository).findById(KEY);

/** The task as stored; fails the test when there is none. */
async function storedTask(app: TestApp): Promise<A2ATaskRecord> {
  const task = await taskOn(app);
  if (task === undefined) throw new Error("the task is not stored");
  return task;
}

function controlOf(app: TestApp): ExecutionControl {
  const control = executionControlOf(app);
  if (control === undefined) throw new Error("no execution control");
  return control;
}

describe("#807 AC3: the projection moves the task with its execution", () => {
  exposed("start → WORKING → COMPLETED with the finish's output", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(callTool(Step, { text: "one" }), done);
    await accepted(app);

    await run(app);

    expect(await taskOn(app)).toMatchObject({
      status: {
        state: A2ATaskState.Completed,
        finish: "receipt-workflow-finish",
        output: { text: "Done." },
        pendingPauses: [],
      },
      // accepted (1), WORKING (2), COMPLETED (3)
      version: 3,
    });
  });

  exposed(
    "a pause → INPUT_REQUIRED with it; its answer, on the other instance → COMPLETED",
    async ({ apps, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }), done);
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances");
      await accepted(first);
      await second.ready();

      const paused = await run(first);
      const waiting = await taskOn(second);
      await second.resume(answerOf(paused, { approved: true }));

      expect(waiting?.status).toEqual({
        state: A2ATaskState.InputRequired,
        pendingPauses: [
          {
            pauseId: paused.pending[0]?.pauseId,
            kind: PauseKind.Approval,
            ask: paused.pending[0]?.ask,
          },
        ],
      });
      expect((await taskOn(first))?.status).toMatchObject({
        state: A2ATaskState.Completed,
        output: { text: "Done." },
      });
    },
  );

  exposed(
    "a failure → FAILED with its code and that code's fixed text, never the error's",
    async ({ app, mockLlm }) => {
      // the agent's second model call has no script: its step fails
      mockLlm(Clerk).thenReturn(callTool(Step, { text: "one" }));
      await accepted(app);

      await expect(run(app)).rejects.toThrow();

      expect((await taskOn(app))?.status).toEqual({
        state: A2ATaskState.Failed,
        pendingPauses: [],
        errorCode: "step.agent",
        message: "the task failed: step.agent",
      });
      // what GetTask and ListTasks will serve carries no text of the error itself
      const listed = await app
        .resolve(A2ATaskRepository)
        .list({ tenantId: "default", ownerId: undefined, pageSize: 10 });
      expect(JSON.stringify(listed)).not.toMatch(/clerk-agent|script exhausted/u);
    },
  );

  exposed("a cancel of the paused task → CANCELED, and it stays so", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    await accepted(app);
    await run(app);

    await controlOf(app).cancelExecution({
      tenantId: "default",
      rootExecutionId: TASK,
      threadId: "ctx-1",
    });

    expect((await taskOn(app))?.status).toEqual({
      state: A2ATaskState.Canceled,
      pendingPauses: [],
    });
  });

  exposed("an execution that is no task writes no task", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(done);
    await app.ready();

    await execute(app, OrderWorkflowStart, { text: "go" }, { threadId: "ctx-1" });

    const page = await app
      .resolve(A2ATaskRepository)
      .list({ tenantId: "default", ownerId: undefined, pageSize: 10 });
    expect(page.tasks).toEqual([]);
  });

  internal("an application that exposes no A2A projects nothing", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(done);
    await accepted(app);

    await run(app);

    expect(await taskOn(app)).toMatchObject({
      status: { state: A2ATaskState.Submitted },
      version: 1,
    });
  });
});

describe("#807 AC3: a status the events missed is repaired on read", () => {
  internal(
    "a missed finish → COMPLETED with its output, once a lease period passed",
    async ({ app, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(done);
      await accepted(app);
      await run(app);
      const parts = {
        tasks: app.resolve(A2ATaskRepository),
        control: controlOf(app),
        clock,
        staleAfter: seconds(30),
        startTimeout: seconds(60),
      };

      const fresh = await repairedTask(parts, await storedTask(app));
      await clock.advance(seconds(30));
      const repaired = await repairedTask(parts, await storedTask(app));

      expect(fresh.status.state).toBe(A2ATaskState.Submitted);
      expect(repaired).toMatchObject({
        status: { state: A2ATaskState.Completed, output: { text: "Done." } },
        version: 2,
      });
      expect(await taskOn(app)).toEqual(repaired);
    },
  );

  internal("a missed pause → INPUT_REQUIRED with the pause", async ({ app, clock, mockLlm }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    await accepted(app);
    const paused = await run(app);
    await clock.advance(seconds(30));

    const repaired = await repairedTask(
      {
        tasks: app.resolve(A2ATaskRepository),
        control: controlOf(app),
        clock,
        staleAfter: seconds(30),
        startTimeout: seconds(60),
      },
      await storedTask(app),
    );

    expect(repaired.status).toMatchObject({
      state: A2ATaskState.InputRequired,
      pendingPauses: [{ pauseId: paused.pending[0]?.pauseId, kind: PauseKind.Approval }],
    });
  });

  internal(
    "a crash between accept and start: the fence wins, FAILED a2a.start-lost, no start ever",
    async ({ app, clock }) => {
      await accepted(app);
      await clock.advance(seconds(60));

      const repaired = await repairedTask(
        {
          tasks: app.resolve(A2ATaskRepository),
          control: controlOf(app),
          clock,
          staleAfter: seconds(30),
          startTimeout: seconds(60),
        },
        await storedTask(app),
      );

      expect(repaired.status).toMatchObject({
        state: A2ATaskState.Failed,
        errorCode: "a2a.start-lost",
      });
      await expect(run(app)).rejects.toMatchObject({ code: "run.duplicate-execution-id" });
    },
  );
});
