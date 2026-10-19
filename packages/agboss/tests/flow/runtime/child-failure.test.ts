import { beforeEach, describe, expect } from "vitest";
import {
  BranchStatus,
  ChildExecutionFailedError,
  ChildExecutionStatus,
  ExecutionCancelledError,
  StepFailedError,
} from "../../../src/index.js";
import { TestConcurrency, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { ItemFailedError, type ItemDto } from "./fixtures/fan-out.workflow.js";
import {
  CheckBareWorkflowStart,
  CheckItemsWorkflowStart,
  CheckOneWorkflowStart,
  CheckOrFallbackWorkflowStart,
  ChecksFailedWorkflowFinish,
  ChecksSummaryWorkflowFinish,
  ChildrenApplication,
  childLog,
  ItemCheckWorkflow,
  OneCheckedWorkflowFinish,
  OneFailedWorkflowFinish,
  RecheckedWorkflowFinish,
  resetChildLog,
} from "./fixtures/children.workflow.js";

/** #263 PR 2 — a child's failure: AC8, AC9, AC13, S25, S85 (a child as an error handler). */

/** These tests are about the runtime's own concurrency (#262: tests default to one branch at a time). */
const test = testWith(ChildrenApplication, { concurrency: TestConcurrency.Real });
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };

const item = (name: string, delay = 0, outcome: ItemDto["outcome"] = "ok"): ItemDto => ({
  name,
  delay,
  outcome,
});

beforeEach(resetChildLog);

describe("AC8: an uncaught child error fails the parent's step (FailFast)", () => {
  test("FailFast: running siblings are cancelled, no new one starts", async ({ app }) => {
    const items = [item("slow", 200), item("bad", 5, "fail"), item("later"), item("last")];

    const result = await execute(app, CheckItemsWorkflowStart, items, who);

    expect(result).toFinishWith(ChecksFailedWorkflowFinish, { text: "failed on one of 4" });
    expect(childLog.events).toContain("aborted slow");
    expect(childLog.events).not.toContain("start later");
    expect(childLog.events).not.toContain("start last");
    expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
      BranchStatus.Cancelled,
      BranchStatus.Failed,
      BranchStatus.Cancelled,
      BranchStatus.Cancelled,
    ]);
  });

  test("ChildExecutionFailedError fields: cause, childExecutionId, itemIndex", async ({ app }) => {
    const result = await execute(
      app,
      CheckItemsWorkflowStart,
      [item("ok"), item("bad", 0, "fail")],
      {
        ...who,
        record: true,
      },
    );

    const handled = result.handledErrors[0];
    expect(handled).toMatchObject({
      error: {
        code: "step.child",
        lineage: ["step.child", "step.failed", "step", "agboss"],
        details: { itemIndex: 1, nodeId: "item-check-workflow" },
        cause: { code: "step.action", cause: { code: "test.item-failed" } },
      },
      at: { name: "item-check-workflow" },
      by: { name: "checks-failed-workflow-finish" },
    });
    const failed = result.children.find((child) => child.status === ChildExecutionStatus.Failed);
    expect(failed?.itemIndex).toBe(1);
    expect(handled?.error.details?.childExecutionId).toBe(failed?.executionId);
  });

  test("one child: .onError right after .toWorkflow(W) catches it by the cause", async ({
    app,
  }) => {
    const result = await execute(app, CheckOneWorkflowStart, item("bad", 0, "fail"), who);

    expect(result).toFinishWith(OneFailedWorkflowFinish, { text: "could not check bad" });
    expect(result.children).toMatchObject([
      { status: ChildExecutionStatus.Failed, error: { code: "step.child" } },
    ]);
  });

  test("uncaught: the parent fails with ChildExecutionFailedError, the cause inside", async ({
    app,
  }) => {
    const failing = execute(app, CheckBareWorkflowStart, item("bad", 0, "fail"), who);

    await expect(failing).rejects.toBeInstanceOf(ChildExecutionFailedError);
    const error: unknown = await failing.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(StepFailedError);
    expect(error).toMatchObject({
      code: "step.child",
      nodeId: "item-check-workflow",
      visitNumber: 1,
      workflow: { name: "item-check-workflow", version: "1.0.0" },
      cause: { code: "step.action", cause: expect.any(ItemFailedError) },
    });
    expect(childLog.errors).toMatchObject([
      { workflow: { name: "item-check-workflow" }, error: expect.any(ChildExecutionFailedError) },
      { workflow: { name: "check-bare-workflow" }, error: expect.any(ChildExecutionFailedError) },
    ]);
  });
});

describe("AC9: the side path sees the scope before the launch", () => {
  test("onJoinError sees the scope before the launch; finished children in the record", async ({
    app,
  }) => {
    const items = [item("quick"), item("bad", 30, "fail")];

    const result = await execute(app, CheckItemsWorkflowStart, items, { ...who, record: true });

    expect(result).toFinishWith(ChecksFailedWorkflowFinish, { text: "failed on one of 2" });
    const slots = result.record?.scope.map((value) => value.slot) ?? [];
    expect(slots).toEqual(["list:ItemDto"]);
    expect(result.record?.children.map((child) => [child.itemIndex, child.status])).toEqual(
      expect.arrayContaining([
        [0, ChildExecutionStatus.Finished],
        [1, ChildExecutionStatus.Failed],
      ]),
    );
  });
});

describe("AC13: StepFailedError never catches a cancellation", () => {
  test("StepFailedError never catches cancellation or a tree limit", async ({ app }) => {
    const controller = new AbortController();
    const call = execute(app, CheckOrFallbackWorkflowStart, item("slow", 500), {
      ...who,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
  });
});

describe("S85: a child workflow as an error handler", () => {
  test(".onError(E, toWorkflow(W)…) runs the child on the failure", async ({ app }) => {
    const result = await execute(app, CheckOrFallbackWorkflowStart, item("bad", 0, "fail"), who);

    expect(result).toFinishWith(RecheckedWorkflowFinish, { name: "bad (fallback)" });
    expect(result.children).toMatchObject([
      {
        workflow: { name: "fallback-check-workflow" },
        start: { name: "fallback-check-workflow-start" },
        input: { name: "bad" },
        status: ChildExecutionStatus.Finished,
      },
    ]);
    expect(result.handledErrors).toMatchObject([
      { at: { name: "check-item-action" }, by: { name: "fallback-check-workflow" } },
    ]);
  });

  test("no failure, no child", async ({ app }) => {
    const result = await execute(app, CheckOrFallbackWorkflowStart, item("good"), who);

    expect(result).toFinishWith(OneCheckedWorkflowFinish, { name: "good" });
    expect(result.children).toEqual([]);
  });
});

describe("the per-item children end at the summary when none fails", () => {
  test("every child finishes: the join's list in item order", async ({ app }) => {
    const items = [item("a", 20), item("b"), item("c", 10)];

    const result = await execute(app, CheckItemsWorkflowStart, items, who);

    expect(result).toFinishWith(ChecksSummaryWorkflowFinish, { text: "a, b, c" });
    expect(childLog.mostInFlight).toBe(2);
    // AC6: each value arrives as Produced<ItemResultDto, typeof ItemCheckWorkflow>
    expect(childLog.producers).toEqual([ItemCheckWorkflow, ItemCheckWorkflow, ItemCheckWorkflow]);
  });
});
