import { Bool, Text } from "../../../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  listOf,
  oneOf,
  QuorumNotReachedError,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
  Action,
  inline,
} from "../../../../src/index.js";
import { seconds } from "../../../../src/units/index.js";
import { onStart, toFinish, toAction, toWorkflow, toAgent } from "../../../helpers/flow.js";
import {
  GroupDoneDto,
  TaskDoneDto,
  TaskDoneWorkflowFinish,
  TaskDto,
  TaskWorkflow,
  treeLog,
} from "./tree-task.workflow.js";

/**
 * #264 PR 2 (AC9) — a quorum's deadline excludes the time in the tree's queue: a tree of one
 * execution at work at a time, where a task works for its seconds while a vote's two voters (a
 * quorum of 2, `deadline: seconds(30)`) wait for the slot. Each item is routed by code: a task with
 * seconds works, one without is voted on.
 */

export class VoteDto {
  @Bool({ prompt: "whether to go ahead" })
  yes!: boolean;
}

export class VotedDto {
  @Text({ prompt: "what was voted on" })
  name!: string;
}

export class NotVotedDto {
  @Text({ prompt: "what the vote did not decide" })
  name!: string;
}

@Agent({
  name: "first-voter-agent",
  description: "Votes on a task",
  prompt: inline("Vote on the task."),
  model: "moonshotai/kimi-k2.6",
  input: { task: TaskDto },
  output: VoteDto,
})
export class FirstVoterAgent {}

@Agent({
  name: "second-voter-agent",
  description: "Votes on a task",
  prompt: inline("Vote on the task."),
  model: "moonshotai/kimi-k2.6",
  input: { task: TaskDto },
  output: VoteDto,
})
export class SecondVoterAgent {}

@WorkflowStart({ name: "vote-workflow-start", description: "A task to vote on", input: TaskDto })
export class VoteWorkflowStart {}

@Action({
  name: "voted-action",
  description: "The vote decided",
  input: { task: TaskDto, votes: listOf(VoteDto) },
  output: VotedDto,
})
export class VotedAction {
  async execute(input: { readonly task: Produced<TaskDto, unknown> }): Promise<VotedDto> {
    treeLog.events.push(`voted ${input.task.value.name}`);
    return { name: input.task.value.name };
  }
}

@WorkflowFinish({
  name: "voted-workflow-finish",
  description: "The vote decided",
  output: VotedDto,
})
export class VotedWorkflowFinish {}

@Action({
  name: "not-voted-action",
  description: "The vote did not come in time",
  input: { task: TaskDto },
  output: NotVotedDto,
})
export class NotVotedAction {
  async execute(input: { readonly task: Produced<TaskDto, unknown> }): Promise<NotVotedDto> {
    treeLog.events.push(`not voted ${input.task.value.name}`);
    return { name: input.task.value.name };
  }
}

@WorkflowFinish({
  name: "not-voted-workflow-finish",
  description: "The vote did not come in time",
  output: NotVotedDto,
})
export class NotVotedWorkflowFinish {}

@Workflow({
  name: "vote-workflow",
  version: "1.0.0",
  flow: [
    onStart(VoteWorkflowStart)
      .inParallel([toAgent(FirstVoterAgent), toAgent(SecondVoterAgent)])
      .joinQuorum({ min: 2, deadline: seconds(30) })
      .onError(
        QuorumNotReachedError,
        toAction(NotVotedAction)
          .toFinish(NotVotedWorkflowFinish),
      )
      .toAction(VotedAction)
      .toFinish(VotedWorkflowFinish),
  ],
})
export class VoteWorkflow {}

/** A task with seconds works; one without is voted on. */
@Router({
  name: "task-kind-router",
  description: "Works on a task, or has it voted on",
  decidedBy: DecidedBy.Code,
  input: { task: TaskDto },
  routes: [TaskWorkflow, VoteWorkflow],
})
export class TaskKindRouter {
  route(input: { readonly task: Produced<TaskDto, unknown> }): unknown {
    return input.task.value.seconds > 0 ? TaskWorkflow : VoteWorkflow;
  }
}

@WorkflowStart({ name: "mixed-workflow-start", description: "One task", input: TaskDto })
export class MixedWorkflowStart {}

@WorkflowFinish({ name: "mixed-voted-workflow-finish", description: "Voted", output: VotedDto })
export class MixedVotedWorkflowFinish {}

@WorkflowFinish({
  name: "mixed-not-voted-workflow-finish",
  description: "Not voted",
  output: NotVotedDto,
})
export class MixedNotVotedWorkflowFinish {}

@Workflow({
  name: "mixed-workflow",
  version: "1.0.0",
  flow: [
    onStart(MixedWorkflowStart)
      .toRouter(TaskKindRouter)
      .onRoute(
        toWorkflow(TaskWorkflow)
          .toFinish(TaskDoneWorkflowFinish),
      )
      .onRoute(
        toWorkflow(VoteWorkflow)
          .toOneOf([toFinish(MixedNotVotedWorkflowFinish), toFinish(MixedVotedWorkflowFinish)]),
      ),
  ],
})
export class MixedWorkflow {}

@WorkflowStart({
  name: "voting-workflow-start",
  description: "Tasks to work on or vote on",
  input: listOf(TaskDto),
})
export class VotingWorkflowStart {}

@Action({
  name: "voting-done-action",
  description: "Every item done",
  input: { results: listOf(oneOf(NotVotedDto, TaskDoneDto, VotedDto)) },
  output: GroupDoneDto,
})
export class VotingDoneAction {
  async execute(input: {
    readonly results: readonly Produced<unknown, unknown>[];
  }): Promise<GroupDoneDto> {
    return { name: `${String(input.results.length)} done` };
  }
}

@WorkflowFinish({
  name: "voting-done-workflow-finish",
  description: "Every item done",
  output: GroupDoneDto,
})
export class VotingDoneWorkflowFinish {}

/** One execution of the tree at work at a time. */
@Workflow({
  name: "voting-workflow",
  version: "1.0.0",
  flow: [
    onStart(VotingWorkflowStart)
      .forEachItem(toWorkflow(MixedWorkflow), { takeFirst: 5, maxConcurrency: 5 })
      .join()
      .toAction(VotingDoneAction)
      .toFinish(VotingDoneWorkflowFinish),
  ],
  executionLimits: { maxConcurrency: 1 },
})
export class VotingWorkflow {}
