import { EmptyEnvironment, listOf, Workflow, WorkflowStart } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { start } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  BatchDoneWorkflowFinish,
  BatchWorkflow,
} from "../../flow/runtime/fixtures/tree-batch.workflow.js";
import {
  TaskDoneDto,
  TaskDto,
  WorkAction,
} from "../../flow/runtime/fixtures/tree-task.workflow.js";

/**
 * #332 — the instance's cap on steps, `@Application({ maxConcurrentSteps })`. One execution
 * launches an action per task (all in one execution: its tree's cap never stops them), each working
 * for its `seconds` on the application's clock (`tree-task.workflow.ts`: the log counts the most at
 * work at once); the applications cap their instance at 4 and at 1.
 */

@WorkflowStart({
  name: "items-workflow-start",
  description: "The tasks, an action each",
  input: listOf(TaskDto),
})
export class ItemsWorkflowStart {}

/** Up to 20 actions at once by the launch: only the instance's cap holds them back. */
@Workflow({
  name: "items-workflow",
  version: "1.0.0",
  flow: [
    start(ItemsWorkflowStart)
      .returns(listOf(TaskDto))
      .toParallelActions(WorkAction, { maxConcurrency: 20, maxItems: 20 })
      .join()
      .returns(listOf(TaskDoneDto))
      .toFinish(BatchDoneWorkflowFinish),
  ],
})
export class ItemsWorkflow {}

/** Four steps of the instance at work at once. */
@Application({
  name: "step-cap-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ItemsWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 4,
})
export class StepCapApplication {}

/** One step at a time, over a tree of child workflows (`batch-workflow`: its tree's cap is 2). */
@Application({
  name: "single-step-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BatchWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 1,
})
export class SingleStepApplication {}

/** One step at a time on instances that share their stores: a crash, a stop, a recovery. */
@Application({
  name: "step-cap-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ItemsWorkflow],
  observers: [RecoveryLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 1,
})
export class StepCapRecoveryApplication {}
