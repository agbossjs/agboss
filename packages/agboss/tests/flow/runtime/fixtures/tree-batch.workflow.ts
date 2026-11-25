import {
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Action,
  Ttl,
} from "../../../../src/index.js";
import { onStart, toWorkflow } from "../../../helpers/flow.js";
import { GroupDoneDto, TaskDoneDto, TaskDto, TaskWorkflow } from "./tree-task.workflow.js";

/** #264 PR 2 — trees of tasks under a cap of 2, a cap of 1, and a launch stricter than the cap. */

@WorkflowStart({
  name: "batch-workflow-start",
  description: "The tasks, each its own child",
  input: listOf(TaskDto),
})
export class BatchWorkflowStart {}

@Action({
  name: "batch-done-action",
  description: "Every task done",
  input: { done: listOf(TaskDoneDto) },
  output: GroupDoneDto,
})
export class BatchDoneAction {
  async execute(input: { readonly done: readonly Tracked<TaskDoneDto>[] }): Promise<GroupDoneDto> {
    const names = input.done.map((task) => task.name);
    return { name: names.join(", ") };
  }
}

@WorkflowFinish({
  name: "batch-done-workflow-finish",
  description: "Every task done",
  output: GroupDoneDto,
})
export class BatchDoneWorkflowFinish {}

/** Five tasks may start at once; two of the tree work at once. */
@Workflow({
  name: "batch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(BatchWorkflowStart)
      .forEachItem(toWorkflow(TaskWorkflow), { takeFirst: 10, maxConcurrency: 5 })
      .join()
      .toAction(BatchDoneAction)
      .toFinish(BatchDoneWorkflowFinish),
  ],
  executionLimits: { maxConcurrency: 2 },
})
export class BatchWorkflow {}

@WorkflowStart({
  name: "serial-batch-workflow-start",
  description: "The tasks, one at a time by the launch",
  input: listOf(TaskDto),
})
export class SerialBatchWorkflowStart {}

/** The launch's maxConcurrency 1 is stricter than the tree's default 10. */
@Workflow({
  name: "serial-batch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SerialBatchWorkflowStart)
      .forEachItem(toWorkflow(TaskWorkflow), { takeFirst: 10, maxConcurrency: 1 })
      .join()
      .toAction(BatchDoneAction)
      .toFinish(BatchDoneWorkflowFinish),
  ],
})
export class SerialBatchWorkflow {}

@WorkflowStart({
  name: "single-file-workflow-start",
  description: "The tasks, one of the tree at work at a time",
  input: listOf(TaskDto),
})
export class SingleFileWorkflowStart {}

/** One execution of the tree at work at a time: the root waits at its join with no slot. */
@Workflow({
  name: "single-file-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SingleFileWorkflowStart)
      .forEachItem(toWorkflow(TaskWorkflow), { takeFirst: 10, maxConcurrency: 5 })
      .join()
      .toAction(BatchDoneAction)
      .toFinish(BatchDoneWorkflowFinish),
  ],
  executionLimits: { maxConcurrency: 1 },
})
export class SingleFileWorkflow {}
