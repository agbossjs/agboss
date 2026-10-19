import { Flag, Text } from "../../../../src/dto/index.js";
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
} from "../../../../src/index.js";
import { seconds } from "../../../../src/units/index.js";
import { caseOf, route, start, toFinish } from "../../../helpers/flow.js";
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
  @Flag({ prompt: "whether to go ahead" })
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
  prompt: "Vote on the task.",
  model: "moonshotai/kimi-k2.6",
  input: { task: TaskDto },
  output: VoteDto,
})
export class FirstVoterAgent {}

@Agent({
  name: "second-voter-agent",
  description: "Votes on a task",
  prompt: "Vote on the task.",
  model: "moonshotai/kimi-k2.6",
  input: { task: TaskDto },
  output: VoteDto,
})
export class SecondVoterAgent {}

@WorkflowStart({ name: "vote-workflow-start", description: "A task to vote on", input: TaskDto })
export class VoteWorkflowStart {}

@WorkflowFinish({
  name: "voted-workflow-finish",
  description: "The vote decided",
  input: { task: TaskDto, votes: listOf(VoteDto) },
  output: VotedDto,
})
export class VotedWorkflowFinish {
  finish(input: { readonly task: Produced<TaskDto, unknown> }): VotedDto {
    treeLog.events.push(`voted ${input.task.value.name}`);
    return { name: input.task.value.name };
  }
}

@WorkflowFinish({
  name: "not-voted-workflow-finish",
  description: "The vote did not come in time",
  input: { task: TaskDto },
  output: NotVotedDto,
})
export class NotVotedWorkflowFinish {
  finish(input: { readonly task: Produced<TaskDto, unknown> }): NotVotedDto {
    treeLog.events.push(`not voted ${input.task.value.name}`);
    return { name: input.task.value.name };
  }
}

@Workflow({
  name: "vote-workflow",
  version: "1.0.0",
  flow: [
    start(VoteWorkflowStart)
      .returns(TaskDto)
      .toParallelAgents(FirstVoterAgent, SecondVoterAgent)
      .joinQuorum({ min: 2, deadline: seconds(30) })
      .onJoinError(QuorumNotReachedError, toFinish(NotVotedWorkflowFinish))
      .returns(listOf(VoteDto))
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
  routes: [{ target: TaskWorkflow }, { target: VoteWorkflow }],
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
    start(MixedWorkflowStart)
      .returns(TaskDto)
      .toRouter(TaskKindRouter)
      .chooseOne(
        route(TaskWorkflow)
          .returns(TaskDoneDto)
          .toFinish(TaskDoneWorkflowFinish),
        route(VoteWorkflow)
          .returns(oneOf(NotVotedDto, VotedDto))
          .switch(
            caseOf(NotVotedDto)
              .toFinish(MixedNotVotedWorkflowFinish),
            caseOf(VotedDto)
              .toFinish(MixedVotedWorkflowFinish),
          ),
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

@WorkflowFinish({
  name: "voting-done-workflow-finish",
  description: "Every item done",
  input: { results: listOf(oneOf(NotVotedDto, TaskDoneDto, VotedDto)) },
  output: GroupDoneDto,
})
export class VotingDoneWorkflowFinish {
  finish(input: { readonly results: readonly Produced<unknown, unknown>[] }): GroupDoneDto {
    return { name: `${String(input.results.length)} done` };
  }
}

/** One execution of the tree at work at a time. */
@Workflow({
  name: "voting-workflow",
  version: "1.0.0",
  flow: [
    start(VotingWorkflowStart)
      .returns(listOf(TaskDto))
      .toParallelWorkflows(MixedWorkflow, { maxConcurrency: 5, maxItems: 5 })
      .join()
      .returns(listOf(oneOf(NotVotedDto, TaskDoneDto, VotedDto)))
      .toFinish(VotingDoneWorkflowFinish),
  ],
  maxConcurrentExecutions: 1,
})
export class VotingWorkflow {}
