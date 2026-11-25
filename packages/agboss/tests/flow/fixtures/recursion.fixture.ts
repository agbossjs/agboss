import { StepError } from "../../../src/core/error-families/step-errors.js";
import {
  onAction,
  onStart,
  toAction,
  toWorkflow,
  toAgent,
  toFinish,
} from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf, Route } from "../../../src/flow/generated-types.js";
import type { ActionHandler, RouterHandler } from "../../../src/flow/handlers.js";
import { Integer, List, Text } from "../../../src/dto/index.js";
import { inline, Ttl } from "../../../src/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #264 — the issue's recursive topic research in the typed builder: `forEachItem(() => Self, …)` as a per-item
 * launch's target (its join typed as the workflow's own finishes), and as a route of a model and a
 * code router (`Route<R>` names the workflow itself).
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
  @List(Text, { prompt: "the subtopics" })
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
  prompt: inline("Research the topic, or list its subtopics."),
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
    const { level } = input.topic;
    return Promise.resolve(input.tooBroad.subtopics.map((title) => ({ title, level: level + 1 })));
  }
}

@Agent({
  name: "report-merger-agent",
  description: "Merges the subtopics' results",
  prompt: inline("Merge the results."),
  model: "moonshotai/kimi-k2.6",
  input: { topic: ResearchTopicDto, results: listOf(ResearchReportDto, ResearchFailedDto) },
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
    return Promise.resolve({ title: input.topic.title });
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
  modelProvider: TestModelProvider,
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeepResearchWorkflowStart)
      .toAgent(TopicResearcherAgent)
      .onError(StepError, toAction(FailTopicAction))
      .toOneOf([
        toFinish(ResearchReportWorkflowFinish),
        toAction(SplitTopicAction)
          .forEachItem(
            toWorkflow(() => DeepResearchWorkflow),
            { takeFirst: 5, maxConcurrency: 3 },
          )
          .join()
          .toAgent(ReportMergerAgent)
          .onError(StepError, toAction(FailTopicAction))
          .toFinish(ResearchReportWorkflowFinish),
      ]),
    onAction(FailTopicAction)
      .toFinish(ResearchFailedWorkflowFinish),
  ],
  executionLimits: { maxDepth: 4 },
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
  prompt: inline("Outline the topic."),
  model: "moonshotai/kimi-k2.6",
  input: { topic: ResearchTopicDto },
  output: ResearchReportDto,
})
export class OutlineAgent {}

/** Deeper while the topic's level is low: `route()` returns the workflow itself or the agent. */
@Router({
  name: "outline-depth-router",
  description: "One level deeper, or outline here",
  decidedBy: DecidedBy.Code,
  input: { topic: ResearchTopicDto },
  routes: [() => OutlineWorkflow, OutlineAgent],
})
export class OutlineDepthRouter implements RouterHandler<OutlineDepthRouter> {
  route(input: InputOf<OutlineDepthRouter>): Route<OutlineDepthRouter> {
    return input.topic.level < 2 ? OutlineWorkflow : OutlineAgent;
  }
}

/** The same finishes as the research; each recursive workflow names itself with a thunk. */
@Workflow({
  name: "outline-workflow",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OutlineWorkflowStart)
      .toRouter(OutlineDepthRouter)
      .onRoute(
        toWorkflow(() => OutlineWorkflow)
          .toOneOf([
            toFinish(ResearchReportWorkflowFinish),
            toFinish(ResearchFailedWorkflowFinish),
          ]),
      )
      .onRoute(
        toAgent(OutlineAgent)
          .onError(StepError, toAction(FailTopicAction)
            .toFinish(ResearchFailedWorkflowFinish))
          .toFinish(ResearchReportWorkflowFinish),
      ),
  ],
  executionLimits: { maxDepth: 3 },
})
export class OutlineWorkflow {}
