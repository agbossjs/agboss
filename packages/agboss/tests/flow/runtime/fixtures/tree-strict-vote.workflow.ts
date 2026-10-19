import {
  DecidedBy,
  listOf,
  oneOf,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { seconds } from "../../../../src/units/index.js";
import { route, start } from "../../../helpers/flow.js";
import {
  GroupDoneDto,
  TaskDoneDto,
  TaskDoneWorkflowFinish,
  TaskDto,
  TaskWorkflow,
} from "./tree-task.workflow.js";
import {
  FirstVoterAgent,
  MixedVotedWorkflowFinish,
  SecondVoterAgent,
  VoteDto,
  VotedDto,
  VotedWorkflowFinish,
} from "./tree-vote.workflow.js";

/**
 * #264 PR 2 (AC9) — the vote of `tree-vote.workflow.ts` with no `.onJoinError(…)`: a quorum not
 * reached fails the tree, so the test reads `QuorumNotReachedError`'s reason — the effective
 * deadline, the ticket's plus the time in the tree's queue.
 */

@WorkflowStart({ name: "strict-vote-workflow-start", description: "A task", input: TaskDto })
export class StrictVoteWorkflowStart {}

@Workflow({
  name: "strict-vote-workflow",
  version: "1.0.0",
  flow: [
    start(StrictVoteWorkflowStart)
      .returns(TaskDto)
      .toParallelAgents(FirstVoterAgent, SecondVoterAgent)
      .joinQuorum({ min: 2, deadline: seconds(30) })
      .returns(listOf(VoteDto))
      .toFinish(VotedWorkflowFinish),
  ],
})
export class StrictVoteWorkflow {}

/** A task with seconds works; one without is voted on, strictly. */
@Router({
  name: "strict-task-kind-router",
  description: "Works on a task, or has it voted on",
  decidedBy: DecidedBy.Code,
  input: { task: TaskDto },
  routes: [{ target: TaskWorkflow }, { target: StrictVoteWorkflow }],
})
export class StrictTaskKindRouter {
  route(input: { readonly task: Produced<TaskDto, unknown> }): unknown {
    return input.task.value.seconds > 0 ? TaskWorkflow : StrictVoteWorkflow;
  }
}

@WorkflowStart({ name: "strict-mixed-workflow-start", description: "A task", input: TaskDto })
export class StrictMixedWorkflowStart {}

@Workflow({
  name: "strict-mixed-workflow",
  version: "1.0.0",
  flow: [
    start(StrictMixedWorkflowStart)
      .returns(TaskDto)
      .toRouter(StrictTaskKindRouter)
      .chooseOne(
        route(TaskWorkflow)
          .returns(TaskDoneDto)
          .toFinish(TaskDoneWorkflowFinish),
        route(StrictVoteWorkflow)
          .returns(VotedDto)
          .toFinish(MixedVotedWorkflowFinish),
      ),
  ],
})
export class StrictMixedWorkflow {}

@WorkflowStart({
  name: "strict-voting-workflow-start",
  description: "Tasks to work on or vote on",
  input: listOf(TaskDto),
})
export class StrictVotingWorkflowStart {}

@WorkflowFinish({
  name: "strict-voting-done-workflow-finish",
  description: "Every item done",
  input: { results: listOf(oneOf(TaskDoneDto, VotedDto)) },
  output: GroupDoneDto,
})
export class StrictVotingDoneWorkflowFinish {
  finish(input: { readonly results: readonly Produced<unknown, unknown>[] }): GroupDoneDto {
    return { name: `${String(input.results.length)} done` };
  }
}

/** One execution of the tree at work at a time; a vote not reached fails the tree. */
@Workflow({
  name: "strict-voting-workflow",
  version: "1.0.0",
  flow: [
    start(StrictVotingWorkflowStart)
      .returns(listOf(TaskDto))
      .toParallelWorkflows(StrictMixedWorkflow, { maxConcurrency: 5, maxItems: 5 })
      .join()
      .returns(listOf(oneOf(TaskDoneDto, VotedDto)))
      .toFinish(StrictVotingDoneWorkflowFinish),
  ],
  maxConcurrentExecutions: 1,
})
export class StrictVotingWorkflow {}
