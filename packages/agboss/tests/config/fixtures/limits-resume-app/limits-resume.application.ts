import {
  listOf,
  Agent,
  EmptyEnvironment,
  inline,
  Workflow,
  WorkflowStart,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../../../flow/fixtures/dtos.js";
import { onStart, toWorkflow } from "../../../helpers/flow.js";
import {
  BatchDoneAction,
  BatchDoneWorkflowFinish,
  BatchWorkflow,
} from "../../../flow/runtime/fixtures/tree-batch.workflow.js";
import { ConfirmTaskTool } from "../../../flow/runtime/fixtures/tree-checks.workflow.js";
import { DigWorkflow } from "../../../flow/runtime/fixtures/recursion-pause.workflow.js";
import { TaskDto, TaskWorkflow } from "../../../flow/runtime/fixtures/tree-task.workflow.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #1318c: workflows whose limits a profile LOWERS (the declared ones are looser), to hold that the run
 * reads the profile's limit and not the decorator's — in the container that started an execution and in
 * a fresh one that resumes it. `gated-batch-workflow` asks for a confirmation first, then launches its
 * tasks as children under a declared cap of 3.
 */

@WorkflowStart({
  name: "gated-batch-workflow-start",
  description: "A request to turn into tasks",
  input: WorkflowStartTextDto,
})
export class GatedBatchWorkflowStart {}

@Agent({
  name: "task-planner-agent",
  description: "Plans the tasks, after a confirmation",
  prompt: inline("Plan the tasks."),
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmTaskTool],
  input: { request: WorkflowStartTextDto },
  output: listOf(TaskDto),
})
export class TaskPlannerAgent {}

/** Declares a cap of 3; the profile `narrow` lowers it to 1. */
@Workflow({
  name: "gated-batch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxConcurrency: 3 },
  flow: [
    onStart(GatedBatchWorkflowStart)
      .toAgent(TaskPlannerAgent)
      .forEachItem(toWorkflow(TaskWorkflow), { takeFirst: 10, maxConcurrency: 5 })
      .join()
      .toAction(BatchDoneAction)
      .toFinish(BatchDoneWorkflowFinish),
  ],
})
export class GatedBatchWorkflow {}

@Application({
  name: "limits-resume-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [GatedBatchWorkflow, BatchWorkflow, DigWorkflow],
  budgets: TEST_BUDGETS,
})
export class LimitsResumeApplication {}
