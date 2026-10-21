import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { listOf } from "../../../src/flow/dto-wrappers.js";
import { describeWorkflow } from "../../../src/describe/describe-workflow.js";
import { workflowOf } from "../../../src/testing/index.js";
import { start } from "../../helpers/flow.js";
import {
  BatchDoneWorkflowFinish,
  BatchWorkflow,
  BatchWorkflowStart,
  SerialBatchWorkflow,
} from "../runtime/fixtures/tree-batch.workflow.js";
import { NarrowGroupsWorkflow } from "../runtime/fixtures/tree-groups.workflow.js";
import {
  TaskDoneDto,
  TaskDoneWorkflowFinish,
  TaskDto,
  TaskWorkflow,
  TaskWorkflowStart,
  WorkAction,
} from "../runtime/fixtures/tree-task.workflow.js";

/**
 * #264 PR 2 (AC8, AC11) — `@Workflow({ maxConcurrentExecutions })` at assembly: a whole number of
 * executions from 1 (`[limits.max-concurrent-executions-invalid]`); a child's own cap above its
 * parent's is never reached (`[limits.child-concurrency-above-parent]`, a warning); `describe`
 * prints the tree's cap of a workflow that launches children.
 */

type Workflowish = abstract new () => unknown;

let count = 0;
/** A workflow of tasks launching `child` per item, with the cap given. */
function tree(cap: number | undefined, child: Workflowish = TaskWorkflow): Workflowish {
  count += 1;
  const options: WorkflowOptions = {
    name: `cap-${String(count)}-workflow`,
    version: "1.0.0",
    flow: [
      start(BatchWorkflowStart)
        .returns(listOf(TaskDto))
        .toParallelWorkflows(child, { maxItems: 10 })
        .join()
        .returns(listOf(TaskDoneDto))
        .toFinish(BatchDoneWorkflowFinish),
    ],
  };
  @Workflow(cap === undefined ? options : { ...options, maxConcurrentExecutions: cap })
  class CapWorkflow {}
  return CapWorkflow;
}

/** A task workflow whose own cap is given. */
function cappedTask(cap: number): Workflowish {
  count += 1;
  @Workflow({
    name: `capped-task-${String(count)}-workflow`,
    version: "1.0.0",
    flow: [
      start(TaskWorkflowStart)
        .returns(TaskDto)
        .toAction(WorkAction)
        .returns(TaskDoneDto)
        .toFinish(TaskDoneWorkflowFinish),
    ],
    maxConcurrentExecutions: cap,
  })
  class CappedTaskWorkflow {}
  return CappedTaskWorkflow;
}

const errorCodesOf = (target: Workflowish): readonly string[] =>
  checkWorkflow(target).errors.map((found) => found.code);

const CHILD_ABOVE = "limits.child-concurrency-above-parent";

/** The child-cap warnings (a per-item child without a failure finish warns too, #263). */
const warningsOf = (target: Workflowish): readonly string[] =>
  checkWorkflow(target)
    .warnings.filter((found) => found.code === CHILD_ABOVE)
    .map((found) => `${found.code}: ${found.message}`);

describe("[limits.max-concurrent-executions-invalid]: a whole number of executions from 1", () => {
  it("0 and 1.5 fail assembly; 1 and 6 pass; unset is the default 10", () => {
    expect(errorCodesOf(tree(0))).toEqual(["limits.max-concurrent-executions-invalid"]);
    expect(errorCodesOf(tree(1.5))).toEqual(["limits.max-concurrent-executions-invalid"]);
    expect(errorCodesOf(tree(1))).toEqual([]);
    expect(errorCodesOf(tree(6))).toEqual([]);
    expect(errorCodesOf(tree(undefined))).toEqual([]);
  });
});

describe("[limits.child-concurrency-above-parent]: a child's own cap cannot exceed its parent's", () => {
  it("a child's 8 under its parent's 4 warns; under the default 10 it does not", () => {
    const child = cappedTask(8);

    expect(warningsOf(tree(4, child))).toEqual([
      expect.stringMatching(
        /^limits\.child-concurrency-above-parent: cap-\d+-workflow: capped-task-\d+-workflow sets maxConcurrentExecutions 8, above its parent's 4/,
      ),
    ]);
    expect(warningsOf(tree(undefined, child))).toEqual([]);
  });

  it("a child's smaller cap and a child without one pass", () => {
    expect(warningsOf(NarrowGroupsWorkflow)).toEqual([]);
    expect(warningsOf(BatchWorkflow)).toEqual([]);
  });

  it("under --strict the warning is an error", () => {
    const strict = checkWorkflow(tree(2, cappedTask(3)), { strict: true });

    expect(strict.errors.map((found) => found.code)).toContain(CHILD_ABOVE);
  });
});

describe("AC11: describe prints the tree's cap of a workflow that launches children", () => {
  it("set, the default, and none for a workflow without children", async () => {
    const lines = async (target: Workflowish): Promise<readonly string[]> =>
      describeWorkflow(await workflowOf(target, [])).filter((line) =>
        line.startsWith("  maxConcurrentExecutions"),
      );

    expect(await lines(BatchWorkflow)).toEqual([
      "  maxConcurrentExecutions 2 (set) · executions of the tree at work at once",
    ]);
    expect(await lines(SerialBatchWorkflow)).toEqual([
      "  maxConcurrentExecutions 10 (default) · executions of the tree at work at once",
    ]);
    expect(await lines(TaskWorkflow)).toEqual([]);
  });
});
