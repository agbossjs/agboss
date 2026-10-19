import { TerminalUserChannel } from "../../../../src/channels/terminal-channel.js";
import { Text } from "../../../../src/dto/index.js";
import {
  Agent,
  listOf,
  Tool,
  Workflow,
  WorkflowStart,
  type ToolHandler,
} from "../../../../src/index.js";
import { start } from "../../../helpers/flow.js";
import { BatchDoneWorkflowFinish } from "./tree-batch.workflow.js";
import { TaskDoneDto, TaskDoneWorkflowFinish, TaskDto } from "./tree-task.workflow.js";

/** #264 PR 2 — a paused child holds no slot: checks of tasks, one asking for a confirmation. */

export class TaskConfirmationDto {
  @Text({ prompt: "the task to confirm" })
  name!: string;
}

@Tool({
  name: "confirm_task",
  description: "Confirms a task",
  channel: TerminalUserChannel,
  input: TaskConfirmationDto,
  output: TaskConfirmationDto,
})
export class ConfirmTaskTool implements ToolHandler<TaskConfirmationDto, TaskConfirmationDto> {
  run(input: TaskConfirmationDto): Promise<TaskConfirmationDto> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "task-checker-agent",
  description: "Checks one task, asking for a confirmation when it must",
  prompt: "Check the task.",
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmTaskTool],
  input: { task: TaskDto },
  output: TaskDoneDto,
})
export class TaskCheckerAgent {}

@WorkflowStart({ name: "task-check-workflow-start", description: "One task", input: TaskDto })
export class TaskCheckWorkflowStart {}

@Workflow({
  name: "task-check-workflow",
  version: "1.0.0",
  flow: [
    start(TaskCheckWorkflowStart)
      .returns(TaskDto)
      .toAgent(TaskCheckerAgent)
      .returns(TaskDoneDto)
      .toFinish(TaskDoneWorkflowFinish),
  ],
})
export class TaskCheckWorkflow {}

@WorkflowStart({
  name: "checks-workflow-start",
  description: "The tasks to check",
  input: listOf(TaskDto),
})
export class ChecksWorkflowStart {}

@Workflow({
  name: "checks-workflow",
  version: "1.0.0",
  flow: [
    start(ChecksWorkflowStart)
      .returns(listOf(TaskDto))
      .toParallelWorkflows(TaskCheckWorkflow, { maxConcurrency: 5, maxItems: 10 })
      .join()
      .returns(listOf(TaskDoneDto))
      .toFinish(BatchDoneWorkflowFinish),
  ],
  maxConcurrentExecutions: 1,
})
export class ChecksWorkflow {}
