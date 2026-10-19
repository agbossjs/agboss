import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { answerOf, execute } from "../../helpers/flow.js";
import {
  BatchDoneWorkflowFinish,
  BatchWorkflowStart,
  SerialBatchWorkflowStart,
} from "./fixtures/tree-batch.workflow.js";
import { TreeCapApplication } from "./fixtures/tree-cap.applications.js";
import {
  ChecksWorkflowStart,
  ConfirmTaskTool,
  TaskCheckerAgent,
} from "./fixtures/tree-checks.workflow.js";
import {
  GroupsDoneWorkflowFinish,
  GroupsWorkflowStart,
  NarrowGroupsWorkflowStart,
} from "./fixtures/tree-groups.workflow.js";
import {
  resetTreeLog,
  TaskDoneDto,
  treeLog,
  untilLogged,
  type TaskDto,
} from "./fixtures/tree-task.workflow.js";

/**
 * #264 PR 2 — the tree's concurrency cap at run time (AC8): `@Workflow({ maxConcurrentExecutions })`
 * of the root holds how many executions of its tree work at once; the rest wait (no error); a
 * parent at its join and a paused child hold no slot; the stricter of a launch's `maxConcurrency`
 * and the cap wins; a child's own cap holds its subtree. Tasks work on the test's virtual clock.
 */

const test = testWith(TreeCapApplication);

const task = (name: string, outcome: TaskDto["outcome"] = "ok"): TaskDto => ({
  name,
  seconds: 1,
  outcome,
});
const group = (name: string, tasks: readonly TaskDto[]) => ({ name, tasks: [...tasks] });

const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

/** `p` asks for a confirmation first; every check answers with its task's name. */
const checker = (request: ModelRequest) => {
  const name = nameIn(request);
  const confirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return name === "p" && !confirmed
    ? callTool(ConfirmTaskTool, { name })
    : replyWith(TaskDoneDto, { name });
};

beforeEach(resetTreeLog);

describe("AC8: at most maxConcurrentExecutions executions of the tree work at once", () => {
  test("four tasks, a cap of 2: two at work, two waiting — no error", async ({ app, clock }) => {
    const tasks = [task("a"), task("b"), task("c"), task("d")];

    const execution = execute(app, BatchWorkflowStart, tasks);
    await untilLogged("start b");
    const atFirst = [...treeLog.events];
    await clock.advance(seconds(1));
    await untilLogged("start d");
    await clock.advance(seconds(1));
    const result = await execution;

    expect(atFirst).toEqual(["start a", "start b"]);
    expect(treeLog.mostWorking).toBe(2);
    expect(result).toFinishWith(BatchDoneWorkflowFinish, { name: "a, b, c, d" });
  });

  test("the launch's maxConcurrency 1 is stricter than the tree's 10: one at a time", async ({
    app,
    clock,
  }) => {
    const execution = execute(app, SerialBatchWorkflowStart, [task("a"), task("b")]);
    await untilLogged("start a");
    await clock.advance(seconds(1));
    await untilLogged("start b");
    await clock.advance(seconds(1));
    const result = await execution;

    expect(treeLog.mostWorking).toBe(1);
    expect(result).toFinishWith(BatchDoneWorkflowFinish, { name: "a, b" });
  });

  test("a parent waiting at its join holds no slot: a cap of 1 still runs its children", async ({
    app,
    clock,
  }) => {
    const groups = [group("g1", [task("a"), task("b")])];

    const execution = execute(app, GroupsWorkflowStart, groups);
    await untilLogged("start a");
    await clock.advance(seconds(1));
    await untilLogged("start b");
    await clock.advance(seconds(1));
    const result = await execution;

    expect(treeLog.mostWorking).toBe(1);
    expect(treeLog.events).toEqual(["start a", "end a", "start b", "end b", "close g1"]);
    expect(result).toFinishWith(GroupsDoneWorkflowFinish, { name: "g1" });
  });

  test("a paused child holds no slot: its siblings work while it waits", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TaskCheckerAgent).thenAnswer(checker);

    const paused = await execute(app, ChecksWorkflowStart, [task("p"), task("a"), task("b")]);
    const resumed = await app.resume(answerOf(paused, { approved: true }));

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(mockLlm(TaskCheckerAgent).requests.map(nameIn)).toEqual(["p", "a", "b", "p"]);
    expect(resumed).toFinishWith(BatchDoneWorkflowFinish, { name: "p, a, b" });
  });

  test("a child's own cap holds its subtree inside the tree's", async ({ app, clock }) => {
    const groups = [group("g1", [task("a"), task("b")]), group("g2", [task("c"), task("d")])];

    const execution = execute(app, NarrowGroupsWorkflowStart, groups);
    await untilLogged("start c");
    const atFirst = [...treeLog.events];
    await clock.advance(seconds(1));
    await untilLogged("start d");
    await clock.advance(seconds(1));
    const result = await execution;

    // the tree allows 4, each group 1: one task of each group at a time
    expect(atFirst).toEqual(["start a", "start c"]);
    expect(treeLog.mostWorking).toBe(2);
    expect(result).toFinishWith(GroupsDoneWorkflowFinish, { name: "g1, g2" });
  });
});
