import { listOf, Action, Workflow, WorkflowFinish, WorkflowStart, type Produced } from "../../../../src/index.js";
import { start } from "../../../helpers/flow.js";
import {
  GroupDoneDto,
  GroupDto,
  TaskDoneDto,
  TaskDto,
  TaskWorkflow,
  treeLog,
} from "./tree-task.workflow.js";

/**
 * #264 PR 2 — groups of tasks, three levels deep: a group closes once its tasks are done (a parent
 * that closes its branch goes first), and a group may cap its own subtree.
 */

@Action({
  name: "group-tasks-action",
  description: "The group's tasks",
  input: { group: GroupDto },
  output: listOf(TaskDto),
})
export class GroupTasksAction {
  execute(input: { readonly group: Produced<GroupDto, unknown> }): Promise<TaskDto[]> {
    return Promise.resolve(input.group.value.tasks);
  }
}

@Action({
  name: "close-group-action",
  description: "Closes the group once its tasks are done",
  input: { group: GroupDto, done: listOf(TaskDoneDto) },
  output: GroupDoneDto,
})
export class CloseGroupAction {
  execute(input: { readonly group: Produced<GroupDto, unknown> }): Promise<GroupDoneDto> {
    const { name } = input.group.value;
    treeLog.events.push(`close ${name}`);
    return Promise.resolve({ name });
  }
}

@WorkflowStart({ name: "group-workflow-start", description: "One group", input: GroupDto })
export class GroupWorkflowStart {}

@WorkflowFinish({ name: "group-done-workflow-finish", description: "Done", output: GroupDoneDto })
export class GroupDoneWorkflowFinish {}

const groupPath = (from: typeof GroupWorkflowStart) =>
  start(from)
    .returns(GroupDto)
    .toAction(GroupTasksAction)
    .returns(listOf(TaskDto))
    .toParallelWorkflows(TaskWorkflow, { maxConcurrency: 5, maxItems: 10 })
    .join()
    .returns(listOf(TaskDoneDto))
    .toAction(CloseGroupAction)
    .returns(GroupDoneDto)
    .toFinish(GroupDoneWorkflowFinish);

@Workflow({ name: "group-workflow", version: "1.0.0", flow: [groupPath(GroupWorkflowStart)] })
export class GroupWorkflow {}

@WorkflowStart({ name: "narrow-group-workflow-start", description: "One group", input: GroupDto })
export class NarrowGroupWorkflowStart {}

/** A group whose own subtree works one execution at a time. */
@Workflow({
  name: "narrow-group-workflow",
  version: "1.0.0",
  flow: [groupPath(NarrowGroupWorkflowStart)],
  maxConcurrentExecutions: 1,
})
export class NarrowGroupWorkflow {}

@WorkflowStart({
  name: "groups-workflow-start",
  description: "The groups, each its own child",
  input: listOf(GroupDto),
})
export class GroupsWorkflowStart {}

@WorkflowFinish({
  name: "groups-done-workflow-finish",
  description: "Every group done",
  input: { done: listOf(GroupDoneDto) },
  output: GroupDoneDto,
})
export class GroupsDoneWorkflowFinish {
  finish(input: { readonly done: readonly Produced<GroupDoneDto, unknown>[] }): GroupDoneDto {
    const names = input.done.map((group) => group.value.name);
    return { name: names.join(", ") };
  }
}

/** Groups of tasks, one execution of the tree at work at a time. */
@Workflow({
  name: "groups-workflow",
  version: "1.0.0",
  flow: [
    start(GroupsWorkflowStart)
      .returns(listOf(GroupDto))
      .toParallelWorkflows(GroupWorkflow, { maxConcurrency: 5, maxItems: 10 })
      .join()
      .returns(listOf(GroupDoneDto))
      .toFinish(GroupsDoneWorkflowFinish),
  ],
  maxConcurrentExecutions: 1,
})
export class GroupsWorkflow {}

@WorkflowStart({
  name: "narrow-groups-workflow-start",
  description: "The groups, each its own child",
  input: listOf(GroupDto),
})
export class NarrowGroupsWorkflowStart {}

/** A wide tree whose groups each work one task at a time. */
@Workflow({
  name: "narrow-groups-workflow",
  version: "1.0.0",
  flow: [
    start(NarrowGroupsWorkflowStart)
      .returns(listOf(GroupDto))
      .toParallelWorkflows(NarrowGroupWorkflow, { maxConcurrency: 5, maxItems: 10 })
      .join()
      .returns(listOf(GroupDoneDto))
      .toFinish(GroupsDoneWorkflowFinish),
  ],
  maxConcurrentExecutions: 4,
})
export class NarrowGroupsWorkflow {}
