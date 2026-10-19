import { beforeEach, describe, expect } from "vitest";
import { DepthLimitExceededError, LimitExceededError, ThisWorkflow } from "../../../src/index.js";
import { ChildExecutionStatus } from "../../../src/flow/runtime/child-records.js";
import { TestConcurrency, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  CountDoneWorkflowFinish,
  CountdownWorkflowStart,
  CountStoppedWorkflowFinish,
  DepthStoppedAction,
  RecursionApplication,
  resetRecursionLog,
  ShallowWorkflowStart,
  SplitStoppedAction,
  SplitWorkflowStart,
} from "./fixtures/recursion.workflow.js";

/**
 * #264 AC6 — the hard stop: a recursion launched by code past `maxDepth` does not start; the level
 * above gets `ChildExecutionFailedError` caused by `DepthLimitExceededError`, which
 * `.onError(LimitExceededError, …)` right after `.toWorkflow(ThisWorkflow)` takes — and
 * `.onJoinError(LimitExceededError, …)` after a per-item launch's join.
 */

const test = testWith(RecursionApplication);
/** Per-item children all launched at once, as the runtime does (#262: one at a time by default). */
const real = testWith(RecursionApplication, { concurrency: TestConcurrency.Real });

beforeEach(() => {
  resetRecursionLog();
});

describe("AC6: .toWorkflow(ThisWorkflow) by code past maxDepth", () => {
  test("a count that ends in time: two levels, no limit", async ({ app }) => {
    const result = await execute(app, CountdownWorkflowStart, { left: 1 });

    expect(result).toFinishWith(CountDoneWorkflowFinish, { depth: 2 });
    expect(result.children.map((child) => child.depth)).toEqual([2]);
  });

  test("level 3 (maxDepth) launching level 4: refused, taken by its .onError", async ({ app }) => {
    const result = await execute(app, CountdownWorkflowStart, { left: 5 });

    expect(result).toFinishWith(CountStoppedWorkflowFinish, { depth: 3 });
    const third = result.children[0]?.children[0];
    expect(third?.depth).toBe(3);
    expect(third?.path).toContain("depth-stopped-action");
    const refused = third?.children[0];
    expect(refused).toMatchObject({
      depth: 4,
      status: ChildExecutionStatus.Failed,
      path: [],
      error: { name: "DepthLimitExceededError", code: "limit.depth" },
    });
    expect(refused?.error?.message).toBe(
      "countdown-workflow went 4 levels deep; its maxDepth is 3",
    );
  });

  test("the error names the limit as the decorator does and the depth reached", () => {
    const workflow = { name: "countdown-workflow", version: "1.0.0", startedVersion: "1.0.0" };
    const error = new DepthLimitExceededError(workflow, 3, ["countdown-action"]);

    expect(error).toBeInstanceOf(LimitExceededError);
    expect(error).toMatchObject({ code: "limit.depth", workflow, maxDepth: 3, depth: 4 });
  });

  test("the level above handles ChildExecutionFailedError caused by it", async ({ app }) => {
    const result = await execute(app, ShallowWorkflowStart, { left: 1 });

    expect(result).toFinishWith(CountStoppedWorkflowFinish, { depth: 1 });
    expect(result).toHaveHandledError(DepthLimitExceededError, {
      at: ThisWorkflow,
      by: DepthStoppedAction,
    });
    expect(result.handledErrors[0]?.error).toMatchObject({
      name: "ChildExecutionFailedError",
      cause: { name: "DepthLimitExceededError" },
    });
  });
});

describe("AC6: .toParallelWorkflows(ThisWorkflow) by code past maxDepth", () => {
  real(
    "each level-2 child's launch is refused; its .onJoinError finishes it",
    async ({ app, mockAction }) => {
      const result = await execute(app, SplitWorkflowStart, { left: 5 });

      expect(result).toFinishWith(CountDoneWorkflowFinish, { depth: 1 });
      // both items of each level-2 child are refused before they start; its join error finishes it
      const levels = result.children.map((child) => ({
        input: child.input,
        finish: child.finish?.name,
        refused: child.children.map((refused) => [refused.depth, refused.error?.code]),
      }));
      const refused = [
        [3, "limit.depth"],
        [3, "limit.depth"],
      ];
      expect(levels).toEqual([
        { input: { left: 4 }, finish: "count-stopped-workflow-finish", refused },
        { input: { left: 4 }, finish: "count-stopped-workflow-finish", refused },
      ]);
      expect(mockAction(SplitStoppedAction)).toHaveBeenCalledTimes(2);
    },
  );
});
