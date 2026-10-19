import { beforeEach, describe, expect } from "vitest";
import {
  ApplicationStoppingError,
  ChildExecutionFailedError,
  QuorumNotReachedError,
} from "../../../src/index.js";
import { replyWith, TestConcurrency, testWith, waitFor } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { ends, resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import { SingleFileWorkflowStart } from "./fixtures/tree-batch.workflow.js";
import {
  TreeCapApplication,
  TreeCapRecoveryApplication,
} from "./fixtures/tree-cap.applications.js";
import { GroupsDoneWorkflowFinish, GroupsWorkflowStart } from "./fixtures/tree-groups.workflow.js";
import { resetTreeLog, treeLog, untilLogged, type TaskDto } from "./fixtures/tree-task.workflow.js";
import {
  FirstVoterAgent,
  SecondVoterAgent,
  VoteDto,
  VotingDoneWorkflowFinish,
  VotingWorkflowStart,
} from "./fixtures/tree-vote.workflow.js";
import { StrictVotingWorkflowStart } from "./fixtures/tree-strict-vote.workflow.js";

/**
 * #264 PR 2 — the tree's queue (AC9, AC10): a parent that closes its branch goes first, then the
 * deepest; a quorum's deadline excludes the time its voters wait for a slot; a `FailFast` failure
 * empties the queue; after a crash the other instance rebuilds it from the unfinished tasks.
 */

/** The tree's slots are about branches running at once: real concurrency, not the default order. */
const REAL = { concurrency: TestConcurrency.Real };
const test = testWith(TreeCapApplication, REAL);
const instances = testWith(TreeCapRecoveryApplication, { ...REAL, instances: 2 });

const task = (name: string, outcome: TaskDto["outcome"] = "ok"): TaskDto => ({
  name,
  seconds: 1,
  outcome,
});
/** A task done at once: no wait on the clock. */
const instant = (name: string, outcome: TaskDto["outcome"] = "ok"): TaskDto => ({
  name,
  seconds: 0,
  outcome,
});
const group = (name: string, tasks: readonly TaskDto[]) => ({ name, tasks: [...tasks] });

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

beforeEach(() => {
  resetTreeLog();
  resetRecovery();
});

describe("AC9: a parent that closes its branch goes first, then the deepest", () => {
  test("g1's last task done: g1 closes before g2's waiting tasks go on", async ({ app, clock }) => {
    const groups = [group("g1", [task("a")]), group("g2", [task("b"), task("c"), task("d")])];

    const execution = execute(app, GroupsWorkflowStart, groups);
    await untilLogged("start a");
    await clock.advance(seconds(1));
    await untilLogged("start b");
    await clock.advance(seconds(1));
    await untilLogged("start c");
    await clock.advance(seconds(1));
    await untilLogged("start d");
    await clock.advance(seconds(1));
    const result = await execution;

    expect(treeLog.events).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "close g1",
      "start c",
      "end c",
      "start d",
      "end d",
      "close g2",
    ]);
    expect(result).toFinishWith(GroupsDoneWorkflowFinish, { name: "g1, g2" });
  });
});

describe("AC9: time in the queue does not count toward a quorum's deadline", () => {
  test("a quorum's deadline excludes the time its voters wait for a slot (#279)", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(FirstVoterAgent).thenReturn(replyWith(VoteDto, { yes: true }));
    mockLlm(SecondVoterAgent).thenReturn(replyWith(VoteDto, { yes: true }));
    const items = [{ name: "w", seconds: 40, outcome: "ok" }, instant("v")];

    const execution = execute(app, VotingWorkflowStart, items);
    await untilLogged("start w");
    await clock.advance(seconds(40));
    const result = await execution;

    // the voters waited 40 s behind w: past the 30 s deadline, but that was the tree's queue
    expect(treeLog.events).toEqual(["start w", "end w", "voted v"]);
    expect(result).toFinishWith(VotingDoneWorkflowFinish, { name: "2 done" });
  });

  test("past the moved deadline the reason names it: the ticket's plus the time in the queue", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(FirstVoterAgent).thenReturn(replyWith(VoteDto, { yes: true }));
    mockLlm(SecondVoterAgent).thenReturn(waitFor(seconds(31)), replyWith(VoteDto, { yes: true }));
    const items = [{ name: "w", seconds: 40, outcome: "ok" }, instant("v")];

    const execution = execute(app, StrictVotingWorkflowStart, items);
    execution.catch(() => undefined);
    await untilLogged("start w");
    await clock.advance(seconds(40));
    await clock.advance(seconds(31));

    // dispatched at 09:00:00 with a 30 s deadline, 40 s in the queue: it passed at 09:01:10
    await expect(execution).rejects.toFailWith(QuorumNotReachedError, {
      message: expect.stringContaining(
        "the deadline passed (2026-01-05T09:01:10.000Z: the ticket's deadline plus 40 s in the tree's queue)",
      ) as string,
    });
  });
});

describe("AC10: the queue after a failure, a pause and a crash", () => {
  test("a FailFast failure empties the queue: the waiting tasks never start", async ({
    app,
    clock,
  }) => {
    const tasks = [task("x", "fail"), task("a"), task("b"), task("c")];

    const execution = execute(app, SingleFileWorkflowStart, tasks);
    execution.catch(() => undefined);
    await untilLogged("start x");
    await clock.advance(seconds(1));

    await expect(execution).rejects.toBeInstanceOf(ChildExecutionFailedError);
    // x's slot went to a before its failure reached the launch; b and c left the queue unstarted
    expect(treeLog.events).toEqual(["start x", "start a", "cancelled a"]);
  });

  instances(
    "a crash with a full queue: the other instance rebuilds it from the unfinished tasks",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      const first = instance(apps, 0);
      const tasks = [instant("hold", "hold"), instant("a"), instant("c")];
      const call = execute(first, SingleFileWorkflowStart, tasks);
      call.catch(() => undefined);
      await untilLogged("start hold");
      const atCrash = [...treeLog.events];

      await clock.advance(seconds(5));
      const closed = first.close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;
      await clock.advance(seconds(20));
      const seen = await ends(4);

      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      // a and c waited in the queue behind hold when the instance stopped
      expect(atCrash).toEqual(["start hold"]);
      expect(treeLog.events.slice(1)).toEqual([
        "start hold",
        "end hold",
        "start a",
        "end a",
        "start c",
        "end c",
      ]);
      expect(treeLog.mostWorking).toBe(1);
      const root = seen.find((end) => end.finish === "batch-done-workflow-finish");
      expect(root?.output).toEqual({ name: "hold, a, c" });
    },
  );
});
