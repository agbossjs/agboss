import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  callTool,
  replyWith,
  TestConcurrency,
  testWith,
  type ModelRequest,
} from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  BatchDoneWorkflowFinish,
  BatchWorkflowStart,
} from "../flow/runtime/fixtures/tree-batch.workflow.js";
import { ConfirmTaskTool } from "../flow/runtime/fixtures/tree-checks.workflow.js";
import {
  CountDoneDto,
  CountDoneWorkflowFinish,
  CountDto,
  resetRecursionLog,
} from "../flow/runtime/fixtures/recursion.workflow.js";
import {
  ConfirmDigTool,
  DiggerAgent,
  DigWorkflowStart,
} from "../flow/runtime/fixtures/recursion-pause.workflow.js";
import {
  resetTreeLog,
  treeLog,
  untilLogged,
  TaskDto,
} from "../flow/runtime/fixtures/tree-task.workflow.js";
import {
  GatedBatchWorkflowStart,
  LimitsResumeApplication,
  TaskPlannerAgent,
} from "./fixtures/limits-resume-app/limits-resume.application.js";

/**
 * #1318c: a profile that LOWERS a limit is the limit the runtime enforces: the tree's queue (the slot claim of
 * `TreeSlotRegistry`) and the recursion's depth read the assembly's carrier, never the decorator's looser
 * value — also after a resume in a fresh container, which assembles its own carrier from the same profile.
 */

const REAL = { concurrency: TestConcurrency.Real };
const declared = testWith(LimitsResumeApplication, REAL);
const narrow = testWith(LimitsResumeApplication, { ...REAL, profile: "narrow" });
const narrowDepth = testWith(LimitsResumeApplication, { profile: "narrow" });
const declaredDepth = testWith(LimitsResumeApplication);

const task = (name: string): TaskDto => ({ name, seconds: 1, outcome: "ok" });
const tasks = [task("a"), task("b"), task("c")];

const planner = (request: ModelRequest) => {
  const isConfirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return isConfirmed ? replyWith(TaskDto, tasks) : callTool(ConfirmTaskTool, { name: "plan" });
};

const textOf = (request: ModelRequest): string =>
  typeof request.input === "string" ? request.input : JSON.stringify(request.input);

const digger = (request: ModelRequest) => {
  const left = Number(/"left": (\d+)/.exec(textOf(request))?.[1] ?? "0");
  const isConfirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  const canGoDeeper =
    request.kind === "chat" &&
    request.tools.some((tool) => tool.function.name === "answer-count-dto");
  if (left === 1 && !isConfirmed) return callTool(ConfirmDigTool, { left });
  return left > 0 && canGoDeeper
    ? replyWith(CountDto, { left: left - 1 })
    : replyWith(CountDoneDto, { depth: left });
};

beforeEach(() => {
  resetTreeLog();
  resetRecursionLog();
});

describe("maxConcurrency lowered by a profile: the queue holds it", () => {
  declared("declared cap 3: the three tasks work at once", async ({ app, clock, mockModel }) => {
    mockModel(TaskPlannerAgent).respondWith(planner);
    const paused = await execute(app, GatedBatchWorkflowStart, { text: "go" });
    const run = app.resume(answerOf(paused, { approved: true }), { tenantId: "default" });
    await untilLogged("start c");
    await clock.advance(seconds(1));
    await run;

    expect(treeLog.mostWorking).toBe(3);
  });

  narrow("a profile's cap 1: one task at a time", async ({ app, clock, mockModel }) => {
    mockModel(TaskPlannerAgent).respondWith(planner);
    const paused = await execute(app, GatedBatchWorkflowStart, { text: "go" });
    const run = app.resume(answerOf(paused, { approved: true }), { tenantId: "default" });
    for (const name of ["a", "b", "c"]) {
      await untilLogged(`start ${name}`);
      await clock.advance(seconds(1));
    }
    const result = await run;

    expect(treeLog.mostWorking).toBe(1);
    expect(result).toFinishWith(BatchDoneWorkflowFinish, { name: "a, b, c" });
  });

  narrow(
    "after a resume in a fresh container the profile's cap 1 still holds",
    async ({ app, recoverApp, clock, mockModel }) => {
      mockModel(TaskPlannerAgent).respondWith(planner);
      const paused = await execute(app, GatedBatchWorkflowStart, { text: "go" });
      expect(paused.status).toBe(ExecutionStatus.Paused);

      const restarted = await recoverApp();
      const run = restarted.resume(answerOf(paused, { approved: true }), { tenantId: "default" });
      for (const name of ["a", "b", "c"]) {
        await untilLogged(`start ${name}`);
        await clock.advance(seconds(1));
      }
      const result = await run;

      expect(treeLog.mostWorking).toBe(1);
      expect(result).toFinishWith(BatchDoneWorkflowFinish, { name: "a, b, c" });
    },
  );

  narrow("a tree that never paused: a cap of 1 against a declared 2", async ({ app, clock }) => {
    const run = execute(app, BatchWorkflowStart, tasks);
    for (const name of ["a", "b", "c"]) {
      await untilLogged(`start ${name}`);
      await clock.advance(seconds(1));
    }
    await run;

    expect(treeLog.mostWorking).toBe(1);
  });
});

describe("maxDepth lowered by a profile: a child launch holds it", () => {
  declaredDepth(
    "declared 3: the pause at level 2 resumes into a level 3",
    async ({ app, mockModel }) => {
      mockModel(DiggerAgent).respondWith(digger);
      const paused = await execute(app, DigWorkflowStart, { left: 2 });
      const done = await app.resume(answerOf(paused, { approved: true }), { tenantId: "default" });

      expect(done.children[0]?.children.map((child) => child.depth)).toEqual([3]);
    },
  );

  narrowDepth(
    "a profile's 2: the level-2 execution launches no level 3",
    async ({ app, mockModel }) => {
      mockModel(DiggerAgent).respondWith(digger);
      const paused = await execute(app, DigWorkflowStart, { left: 2 });
      const done = await app.resume(answerOf(paused, { approved: true }), { tenantId: "default" });

      expect(done).toFinishWith(CountDoneWorkflowFinish, { depth: 1 });
      expect(done.children[0]?.children ?? []).toEqual([]);
    },
  );

  narrowDepth(
    "after a resume in a fresh container the profile's 2 still holds",
    async ({ app, recoverApp, mockModel }) => {
      mockModel(DiggerAgent).respondWith(digger);
      const paused = await execute(app, DigWorkflowStart, { left: 2 });

      const restarted = await recoverApp();
      const done = await restarted.resume(answerOf(paused, { approved: true }), {
        tenantId: "default",
      });

      expect(done).toFinishWith(CountDoneWorkflowFinish, { depth: 1 });
      expect(done.children[0]?.children ?? []).toEqual([]);
    },
  );
});
