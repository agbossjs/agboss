import { action, caseOf, route, start, toAction } from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf, Route } from "../../../src/flow/generated-types.js";
import type { ActionHandler, RouterHandler } from "../../../src/flow/handlers.js";
import { ThisWorkflow } from "../../../src/flow/this-workflow.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { Integer, ListOf, Text } from "../../../src/dto/index.js";

/**
 * #264 — the issue's recursive topic research in the typed builder: `ThisWorkflow` as a per-item
 * launch's target (its join typed as the workflow's own finishes), and as a route of a model and a
 * code router (`Route<R>` names `typeof ThisWorkflow`).
 */

export class ResearchTopicDto {
  @Text({ prompt: "the topic" })
  title!: string;

  @Integer({ prompt: "the topic's level: 0 for the first topic" })
  level!: number;
}

export class ResearchReportDto {
  @Text({ prompt: "the report" })
  text!: string;
}

export class ResearchTooBroadDto {
  @ListOf(Text, { prompt: "the subtopics" })
  subtopics!: string[];
}

export class ResearchFailedDto {
  @Text({ prompt: "the topic" })
  title!: string;
}

@WorkflowStart({
  name: "deep-research-workflow-start",
  description: "A topic to research",
  input: ResearchTopicDto,
})
export class DeepResearchWorkflowStart {}

@Agent({
  name: "topic-researcher-agent",
  description: "Researches a topic, or lists its subtopics",
  prompt: "Research the topic, or list its subtopics.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: ResearchTopicDto },
  output: oneOf(ResearchReportDto, ResearchTooBroadDto),
})
export class TopicResearcherAgent {}

@Action({
  name: "split-topic-action",
  description: "Splits a topic into subtopics",
  input: { topic: ResearchTopicDto, tooBroad: ResearchTooBroadDto },
  output: listOf(ResearchTopicDto),
})
export class SplitTopicAction implements ActionHandler<SplitTopicAction> {
  execute(input: InputOf<SplitTopicAction>): Promise<OutputOf<SplitTopicAction>> {
    const { level } = input.topic.value;
    return Promise.resolve(
      input.tooBroad.value.subtopics.map((title) => ({ title, level: level + 1 })),
    );
  }
}

@Agent({
  name: "report-merger-agent",
  description: "Merges the subtopics' results",
  prompt: "Merge the results.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: ResearchTopicDto, results: listOf(oneOf(ResearchReportDto, ResearchFailedDto)) },
  output: ResearchReportDto,
})
export class ReportMergerAgent {}

@Action({
  name: "fail-topic-action",
  description: "Records a topic that could not be researched",
  input: { topic: ResearchTopicDto },
  output: ResearchFailedDto,
})
export class FailTopicAction implements ActionHandler<FailTopicAction> {
  execute(input: InputOf<FailTopicAction>): Promise<OutputOf<FailTopicAction>> {
    return Promise.resolve({ title: input.topic.value.title });
  }
}

@WorkflowFinish({
  name: "research-report-workflow-finish",
  description: "The report",
  output: ResearchReportDto,
})
export class ResearchReportWorkflowFinish {}

@WorkflowFinish({
  name: "research-failed-workflow-finish",
  description: "No report",
  output: ResearchFailedDto,
})
export class ResearchFailedWorkflowFinish {}

@Workflow({
  name: "deep-research-workflow",
  version: "1.0.0",
  flow: [
    start(DeepResearchWorkflowStart)
      .returns(ResearchTopicDto)
      .toAgent(TopicResearcherAgent)
      .onError(StepFailedError, toAction(FailTopicAction))
      .returns(oneOf(ResearchReportDto, ResearchTooBroadDto))
      .switch(
        caseOf(ResearchReportDto)
          .toFinish(ResearchReportWorkflowFinish),
        caseOf(ResearchTooBroadDto)
          .toAction(SplitTopicAction)
          .returns(listOf(ResearchTopicDto))
          .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 3, maxItems: 5 })
          .join()
          .returns(listOf(oneOf(ResearchReportDto, ResearchFailedDto)))
          .toAgent(ReportMergerAgent)
          .onError(StepFailedError, toAction(FailTopicAction))
          .returns(ResearchReportDto)
          .toFinish(ResearchReportWorkflowFinish),
      ),
    action(FailTopicAction)
      .returns(ResearchFailedDto)
      .toFinish(ResearchFailedWorkflowFinish),
  ],
  maxDepth: 4,
})
export class DeepResearchWorkflow {}

@WorkflowStart({
  name: "outline-workflow-start",
  description: "A topic to outline",
  input: ResearchTopicDto,
})
export class OutlineWorkflowStart {}

@Agent({
  name: "outline-agent",
  description: "Outlines the topic",
  prompt: "Outline the topic.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: ResearchTopicDto },
  output: ResearchReportDto,
})
export class OutlineAgent {}

/** Deeper while the topic's level is low: `route()` returns `typeof ThisWorkflow` or the agent. */
@Router({
  name: "outline-depth-router",
  description: "One level deeper, or outline here",
  decidedBy: DecidedBy.Code,
  input: { topic: ResearchTopicDto },
  routes: [{ target: ThisWorkflow }, { target: OutlineAgent }],
})
export class OutlineDepthRouter implements RouterHandler<OutlineDepthRouter> {
  route(input: InputOf<OutlineDepthRouter>): Route<OutlineDepthRouter> {
    return input.topic.value.level < 2 ? ThisWorkflow : OutlineAgent;
  }
}

/** The same finishes as the research; each recursive workflow has its own `ThisWorkflowOutputs` entry. */
@Workflow({
  name: "outline-workflow",
  version: "1.0.0",
  flow: [
    start(OutlineWorkflowStart)
      .returns(ResearchTopicDto)
      .toRouter(OutlineDepthRouter)
      .chooseOne(
        route(ThisWorkflow)
          .returns(oneOf(ResearchReportDto, ResearchFailedDto))
          .switch(
            caseOf(ResearchReportDto)
              .toFinish(ResearchReportWorkflowFinish),
            caseOf(ResearchFailedDto)
              .toFinish(ResearchFailedWorkflowFinish),
          ),
        route(OutlineAgent)
          .onError(
            StepFailedError,
            toAction(FailTopicAction)
              .returns(ResearchFailedDto)
              .toFinish(ResearchFailedWorkflowFinish),
          )
          .returns(ResearchReportDto)
          .toFinish(ResearchReportWorkflowFinish),
      ),
  ],
  maxDepth: 3,
})
export class OutlineWorkflow {}
