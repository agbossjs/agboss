import { beforeEach, describe, expect } from "vitest";
import {
  ActionFailedError,
  ChildExecutionFailedError,
  ExecutionCancelledError,
  StepsLimitExceededError,
} from "../../src/index.js";
import { replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { childMatchers } from "../../src/testing/child-matchers.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ItemFailedError,
  ItemResultDto,
  SummaryDto,
  type ItemDto,
} from "../flow/runtime/fixtures/fan-out.workflow.js";
import {
  CheckItemsWorkflowStart,
  CheckOneWorkflowStart,
  ChecksFailedWorkflowFinish,
  ChildrenApplication,
  CheckItemAction,
  FallbackCheckWorkflow,
  CheckOrFallbackWorkflowStart,
  ItemCheckedWorkflowFinish,
  ItemCheckWorkflow,
  ItemNoteDto,
  ItemReviewerAgent,
  ItemReviewWorkflow,
  OneFailedWorkflowFinish,
  resetChildLog,
  ReviewItemsWorkflowStart,
  ReviewRescueAgent,
} from "../flow/runtime/fixtures/children.workflow.js";

/** #263 AC15 — `toHaveChildExecutions` and `toHaveHandledError` pass and fail as described. */

const test = testWith(ChildrenApplication);
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };
const item = (name: string, delay = 0, outcome: ItemDto["outcome"] = "ok"): ItemDto => ({
  name,
  delay,
  outcome,
});

beforeEach(resetChildLog);

describe("toHaveChildExecutions", () => {
  test("passes: each child's item and how it ended, in item order", async ({ app }) => {
    const items = [item("slow", 200), item("bad", 5, "fail"), item("later")];

    const result = await execute(app, CheckItemsWorkflowStart, items, who);

    expect(result).toHaveChildExecutions(ItemCheckWorkflow, [
      { item: items[0], cancelled: true },
      { item: items[1], failedWith: ItemFailedError },
    ]);
    expect(result).toHaveChildExecutions(ItemCheckWorkflow, [
      { cancelled: true },
      { failedWith: ChildExecutionFailedError },
    ]);
  });

  test("passes for finished children; fails on a wrong finish, item or count", async ({ app }) => {
    const result = await execute(app, CheckItemsWorkflowStart, [item("a"), item("b")], who);

    expect(result).toHaveChildExecutions(ItemCheckWorkflow, [
      { item: item("a"), finish: ItemCheckedWorkflowFinish },
      { item: item("b"), finish: ItemCheckedWorkflowFinish },
    ]);
    expect(result).not.toHaveChildExecutions(ItemCheckWorkflow, [
      { item: item("b"), finish: ItemCheckedWorkflowFinish },
      { item: item("a"), finish: ItemCheckedWorkflowFinish },
    ]);
    expect(result).not.toHaveChildExecutions(ItemCheckWorkflow, [
      { finish: ItemCheckedWorkflowFinish },
    ]);
    expect(result).not.toHaveChildExecutions(ItemCheckWorkflow, [
      { failedWith: ItemFailedError },
      { finish: ItemCheckedWorkflowFinish },
    ]);
    expect(result).not.toHaveChildExecutions(FallbackCheckWorkflow, [{ cancelled: true }]);
    expect(result).toHaveChildExecutions(FallbackCheckWorkflow, []);
  });

  test("a map input matches by one of its fields; the message names what ran", ({ expect }) => {
    const context = {
      isNot: false,
      equals: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    };
    const run = {
      path: [],
      threadId: "t",
      children: [
        {
          executionId: "c1",
          parentExecutionId: "r",
          rootExecutionId: "r",
          workflow: { name: "item-check-workflow", version: "1", startedVersion: "1" },
          launchedBy: { nodeId: "item-check-workflow", visitNumber: 1 },
          start: { name: "s" },
          input: { company: { name: "Acme" }, note: { text: "x" } },
          status: "finished",
          finish: { name: "item-checked-workflow-finish" },
          path: [],
          spend: { totalUsd: 0 },
          children: [],
        },
      ],
      handledErrors: [],
    };

    const passed = childMatchers.toHaveChildExecutions.call(context, run, ItemCheckWorkflow, [
      { item: { name: "Acme" }, finish: ItemCheckedWorkflowFinish },
    ]);
    const failed = childMatchers.toHaveChildExecutions.call(context, run, ItemCheckWorkflow, [
      { item: { name: "Globex" } },
    ]);
    const wrong = childMatchers.toHaveChildExecutions.call(context, "nope", ItemCheckWorkflow, []);

    expect(passed.pass).toBe(true);
    expect(failed.pass).toBe(false);
    expect(failed.message()).toContain("item-check-workflow to run as");
    expect(failed.message()).toContain('{"company":{"name":"Acme"}');
    expect(wrong.message()).toContain("toHaveChildExecutions: expected a run result");
  });
});

describe("toHaveHandledError", () => {
  test("passes by the class, its parent or a cause; at the node, by the side path", async ({
    app,
  }) => {
    const result = await execute(app, CheckItemsWorkflowStart, [item("bad", 0, "fail")], who);

    expect(result).toHaveHandledError(ChildExecutionFailedError, {
      at: ItemCheckWorkflow,
      by: ChecksFailedWorkflowFinish,
    });
    expect(result).toHaveHandledError(ItemFailedError);
    expect(result).toHaveHandledError(ActionFailedError, { at: ItemCheckWorkflow });
    expect(result).not.toHaveHandledError(ExecutionCancelledError);
    expect(result).not.toHaveHandledError(ItemFailedError, { by: OneFailedWorkflowFinish });
    expect(result).not.toHaveHandledError(ItemFailedError, { at: CheckItemAction });
  });

  test("a single child's failure, and a child's limit taken by an agent", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer((request: ModelRequest) =>
      JSON.stringify(request.input).includes("loop")
        ? replyWith(ItemNoteDto, { note: "again" }, { cost: usd(0.001) })
        : replyWith(ItemResultDto, { name: "x" }),
    );
    mockLlm(ReviewRescueAgent).thenReturn(replyWith(SummaryDto, { text: "skip" }));

    const one = await execute(app, CheckOneWorkflowStart, item("bad", 0, "fail"), who);
    const reviews = await execute(app, ReviewItemsWorkflowStart, [item("loop")], who);
    const none = await execute(app, CheckOrFallbackWorkflowStart, item("fine"), who);

    expect(one).toHaveHandledError(ItemFailedError, {
      at: ItemCheckWorkflow,
      by: OneFailedWorkflowFinish,
    });
    expect(reviews).toHaveHandledError(StepsLimitExceededError, {
      at: ItemReviewWorkflow,
      by: ReviewRescueAgent,
    });
    expect(reviews).toHaveChildExecutions(ItemReviewWorkflow, [
      { failedWith: StepsLimitExceededError },
    ]);
    expect(none).not.toHaveHandledError(Error);
  });
});
