import { beforeEach, describe, expect } from "vitest";
import { testWith, TestConcurrency } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ItemResultsWorkflowFinish,
  ItemsWorkflowStart,
  ListFinishApplication,
  resetFanOut,
} from "./fixtures/fan-out.workflow.js";

const test = testWith(ListFinishApplication, { concurrency: TestConcurrency.Real });

beforeEach(resetFanOut);

describe("#1271: a @WorkflowFinish whose output is a list", () => {
  test("the join's values are the execution's output, in the join's order", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, [
      { name: "a", delay: 10, outcome: "ok" },
      { name: "b", delay: 0, outcome: "ok" },
      { name: "c", delay: 5, outcome: "ok" },
    ]);

    expect(result.path.at(-1)).toBe("item-results-workflow-finish");
    expect(result).toFinishWith(ItemResultsWorkflowFinish, [
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
  });

  test("an empty list of items is an empty list output", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, []);

    expect(result.output).toEqual([]);
  });
});
