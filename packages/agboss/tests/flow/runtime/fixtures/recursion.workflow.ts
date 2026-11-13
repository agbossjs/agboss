import { Integer, ListOf, Text } from "../../../../src/dto/index.js";
import {
  Action,
  Agent,
  DecidedBy,
  EmptyEnvironment,
  ExecutionContext,
  LimitExceededError,
  listOf,
  oneOf,
  Router,
  StepFailedError,
  ThisWorkflow,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
  variant,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { action, caseOf, route, start, toAction } from "../../../helpers/flow.js";

/**
 * #264 — recursion at run time. `topic-research-workflow` (the issue's example, `maxDepth: 3`): a
 * researcher reports on a topic or finds it too broad, its subtopics researched each by the
 * workflow itself, per item, and merged. `countdown-workflow` (`maxDepth: 3`): code decides to go
 * one level deeper (`.toWorkflow(ThisWorkflow)`) until its count is spent — past `maxDepth` the
 * launch is refused and the side path finishes. `chain-workflow` / `code-chain-workflow`: a model
 * router and a code router whose route launches `ThisWorkflow` (`maxDepth: 2`).
 */

export class TopicDto {
  @Text({ prompt: "the topic" })
  title!: string;

  @Integer({ prompt: "the topic's level: 0 for the first topic" })
  level!: number;
}

export class TopicReportDto {
  @Text({ prompt: "the topic" })
  title!: string;

  @Text({ prompt: "the report" })
  text!: string;
}

export class TopicTooBroadDto {
  @ListOf(Text, { prompt: "the subtopics" })
  subtopics!: string[];
}

export class TopicFailedDto {
  @Text({ prompt: "the topic" })
  title!: string;
}

/** What the code of each level saw of its execution. */
export interface DepthReading {
  readonly at: string;
  readonly title: string;
  readonly depth: number;
  readonly level: number;
}

export const recursionLog = { readings: [] as DepthReading[] };

export function resetRecursionLog(): void {
  recursionLog.readings.length = 0;
}

@WorkflowStart({
  name: "topic-research-workflow-start",
  description: "A topic to research",
  input: TopicDto,
})
export class TopicResearchWorkflowStart {}

@Agent({
  name: "researcher-agent",
  description: "Researches one topic, or says it is too broad and lists its subtopics",
  prompt: "Research the topic: report on it, or say it is too broad and list its subtopics.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: TopicDto },
  output: oneOf(TopicReportDto, TopicTooBroadDto),
})
export class ResearcherAgent {}

@Action({
  name: "subtopics-action",
  description: "Splits a topic that is too broad into subtopics",
  input: { topic: TopicDto, tooBroad: TopicTooBroadDto },
  output: listOf(TopicDto),
  deps: [ExecutionContext],
})
export class SubtopicsAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: {
    readonly topic: Produced<TopicDto, unknown>;
    readonly tooBroad: Produced<TopicTooBroadDto, unknown>;
  }): Promise<TopicDto[]> {
    const { title, level } = input.topic.value;
    const depth = this.executionContext.depth;
    recursionLog.readings.push({ at: "subtopics-action", title, depth, level });
    return Promise.resolve(
      input.tooBroad.value.subtopics.map((subtopic) => ({ title: subtopic, level: level + 1 })),
    );
  }
}

@Agent({
  name: "merge-agent",
  description: "Merges the subtopics' reports into one report on the topic",
  prompt: "Merge the reports into one report on the topic.",
  model: "moonshotai/kimi-k2.6",
  input: {
    topic: TopicDto,
    results: listOf(oneOf(TopicReportDto, TopicFailedDto)),
  },
  output: TopicReportDto,
})
export class MergeAgent {}

@Action({
  name: "mark-topic-failed-action",
  description: "Records that a topic could not be researched",
  input: { topic: TopicDto },
  output: TopicFailedDto,
  deps: [ExecutionContext],
})
export class MarkTopicFailedAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly topic: Produced<TopicDto, unknown> }): Promise<TopicFailedDto> {
    const { title, level } = input.topic.value;
    const depth = this.executionContext.depth;
    recursionLog.readings.push({ at: "mark-topic-failed-action", title, depth, level });
    return Promise.resolve({ title });
  }
}

@WorkflowFinish({
  name: "topic-report-workflow-finish",
  description: "The report on the topic",
  output: TopicReportDto,
})
export class TopicReportWorkflowFinish {}

@WorkflowFinish({
  name: "topic-failed-workflow-finish",
  description: "The topic could not be researched",
  output: TopicFailedDto,
})
export class TopicFailedWorkflowFinish {}

@Workflow({
  name: "topic-research-workflow",
  version: "1.0.0",
  flow: [
    start(TopicResearchWorkflowStart)
      .returns(TopicDto)
      .toAgent(ResearcherAgent)
      .onError(StepFailedError, toAction(MarkTopicFailedAction))
      .returns(oneOf(TopicReportDto, TopicTooBroadDto))
      .switch(
        caseOf(TopicReportDto)
          .toFinish(TopicReportWorkflowFinish),
        caseOf(TopicTooBroadDto)
          .toAction(SubtopicsAction)
          .returns(listOf(TopicDto))
          .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 3, maxItems: 5 })
          .join()
          .returns(listOf(oneOf(TopicReportDto, TopicFailedDto)))
          .toAgent(MergeAgent)
          .onError(StepFailedError, toAction(MarkTopicFailedAction))
          .returns(TopicReportDto)
          .toFinish(TopicReportWorkflowFinish),
      ),
    action(MarkTopicFailedAction)
      .returns(TopicFailedDto)
      .toFinish(TopicFailedWorkflowFinish),
  ],
  maxDepth: 3,
  maxSteps: 4,
})
export class TopicResearchWorkflow {}

export class CountDto {
  @Integer({ prompt: "how many levels are left to go" })
  left!: number;
}

export class CountDoneDto {
  @Integer({ prompt: "the depth the count ended at" })
  depth!: number;
}

export class CountStoppedDto {
  @Integer({ prompt: "the depth the count was stopped at" })
  depth!: number;
}

@WorkflowStart({ name: "countdown-workflow-start", description: "A count", input: CountDto })
export class CountdownWorkflowStart {}

@Action({
  name: "countdown-action",
  description: "Goes one level deeper while the count lasts",
  input: { count: CountDto },
  output: oneOf(CountDto, CountDoneDto),
  deps: [ExecutionContext],
})
export class CountdownAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly count: Produced<CountDto, unknown> }): Promise<unknown> {
    const { left } = input.count.value;
    const depth = this.executionContext.depth;
    recursionLog.readings.push({ at: "countdown-action", title: String(left), depth, level: left });
    return Promise.resolve(
      left > 0 ? variant(CountDto, { left: left - 1 }) : variant(CountDoneDto, { depth }),
    );
  }
}

@Action({
  name: "depth-stopped-action",
  description: "Records where the count was stopped",
  input: { count: CountDto },
  output: CountStoppedDto,
  deps: [ExecutionContext],
})
export class DepthStoppedAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<CountStoppedDto> {
    return Promise.resolve({ depth: this.executionContext.depth });
  }
}

@WorkflowFinish({ name: "count-done-workflow-finish", description: "Done", output: CountDoneDto })
export class CountDoneWorkflowFinish {}

@WorkflowFinish({
  name: "count-stopped-workflow-finish",
  description: "Stopped at the depth limit",
  output: CountStoppedDto,
})
export class CountStoppedWorkflowFinish {}

/** One level deeper while the count lasts; past `maxDepth` the side path finishes. */
const countdownPath = (from: typeof CountdownWorkflowStart) =>
  start(from)
    .returns(CountDto)
    .toAction(CountdownAction)
    .returns(oneOf(CountDto, CountDoneDto))
    .switch(
      caseOf(CountDto)
        .toWorkflow(ThisWorkflow)
        .onError(
          LimitExceededError,
          toAction(DepthStoppedAction)
            .returns(CountStoppedDto)
            .toFinish(CountStoppedWorkflowFinish),
        )
        .returns(oneOf(CountDoneDto, CountStoppedDto))
        .switch(
          caseOf(CountDoneDto)
            .toFinish(CountDoneWorkflowFinish),
          caseOf(CountStoppedDto)
            .toFinish(CountStoppedWorkflowFinish),
        ),
      caseOf(CountDoneDto)
        .toFinish(CountDoneWorkflowFinish),
    );

@Workflow({
  name: "countdown-workflow",
  version: "1.0.0",
  flow: [countdownPath(CountdownWorkflowStart)],
  maxDepth: 3,
})
export class CountdownWorkflow {}

@WorkflowStart({ name: "shallow-workflow-start", description: "A count", input: CountDto })
export class ShallowWorkflowStart {}

/** The countdown with one level only: the root's own launch is refused. */
@Workflow({
  name: "shallow-workflow",
  version: "1.0.0",
  flow: [countdownPath(ShallowWorkflowStart)],
  maxDepth: 1,
})
export class ShallowWorkflow {}

@WorkflowStart({ name: "split-workflow-start", description: "A count", input: CountDto })
export class SplitWorkflowStart {}

@Action({
  name: "split-action",
  description: "Splits a count in two while it lasts",
  input: { count: CountDto },
  output: listOf(CountDto),
})
export class SplitAction {
  execute(input: { readonly count: Produced<CountDto, unknown> }): Promise<CountDto[]> {
    const { left } = input.count.value;
    return Promise.resolve(left > 0 ? [{ left: left - 1 }, { left: left - 1 }] : []);
  }
}

@Action({
  name: "split-stopped-action",
  description: "Records where the split was stopped",
  input: { count: CountDto },
  output: CountStoppedDto,
  deps: [ExecutionContext],
})
export class SplitStoppedAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<CountStoppedDto> {
    return Promise.resolve({ depth: this.executionContext.depth });
  }
}

@Action({
  name: "sum-action",
  description: "Sums up the halves",
  input: { halves: listOf(oneOf(CountDoneDto, CountStoppedDto)) },
  output: CountDoneDto,
  deps: [ExecutionContext],
})
export class SumAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<CountDoneDto> {
    return Promise.resolve({ depth: this.executionContext.depth });
  }
}

@Workflow({
  name: "split-workflow",
  version: "1.0.0",
  flow: [
    start(SplitWorkflowStart)
      .returns(CountDto)
      .toAction(SplitAction)
      .returns(listOf(CountDto))
      .toParallelWorkflows(ThisWorkflow, { maxItems: 2 })
      .join()
      .onJoinError(
        LimitExceededError,
        toAction(SplitStoppedAction)
          .returns(CountStoppedDto)
          .toFinish(CountStoppedWorkflowFinish),
      )
      .returns(listOf(oneOf(CountDoneDto, CountStoppedDto)))
      .toAction(SumAction)
      .returns(CountDoneDto)
      .toFinish(CountDoneWorkflowFinish),
  ],
  maxDepth: 2,
})
export class SplitWorkflow {}

export class LinkDto {
  @Text({ prompt: "the link" })
  name!: string;
}

export class LinkDoneDto {
  @Text({ prompt: "where the chain ended" })
  name!: string;
}

@WorkflowStart({ name: "chain-workflow-start", description: "A link", input: LinkDto })
export class ChainWorkflowStart {}

@Agent({
  name: "link-agent",
  description: "Ends the chain",
  prompt: "End the chain.",
  model: "moonshotai/kimi-k2.6",
  input: { link: LinkDto },
  output: LinkDoneDto,
})
export class LinkAgent {}

@Router({
  name: "link-router",
  description: "Goes one link further, or ends the chain",
  decidedBy: DecidedBy.Model,
  prompt: "Go one link further, or end the chain.",
  model: "typesafe/jev-1.13",
  input: { link: LinkDto },
  maxVisits: 1,
  routes: [
    { prompt: "Go one link further", target: ThisWorkflow },
    { prompt: "End the chain", target: LinkAgent },
  ],
})
export class LinkRouter {}

@WorkflowFinish({ name: "chain-done-workflow-finish", description: "Done", output: LinkDoneDto })
export class ChainDoneWorkflowFinish {}

@Workflow({
  name: "chain-workflow",
  version: "1.0.0",
  flow: [
    start(ChainWorkflowStart)
      .returns(LinkDto)
      .toRouter(LinkRouter)
      .chooseOne(
        route(ThisWorkflow)
          .returns(LinkDoneDto)
          .toFinish(ChainDoneWorkflowFinish),
        route(LinkAgent)
          .returns(LinkDoneDto)
          .toFinish(ChainDoneWorkflowFinish),
      ),
  ],
  maxDepth: 2,
})
export class ChainWorkflow {}

@WorkflowStart({ name: "code-chain-workflow-start", description: "A link", input: LinkDto })
export class CodeChainWorkflowStart {}

/** Always one link further: on the last level that route is not ready. */
@Router({
  name: "deeper-router",
  description: "Always goes one link further",
  decidedBy: DecidedBy.Code,
  input: { link: LinkDto },
  maxVisits: 1,
  routes: [{ target: ThisWorkflow }, { target: LinkAgent }],
})
export class DeeperRouter {
  route(): unknown {
    return ThisWorkflow;
  }
}

@Workflow({
  name: "code-chain-workflow",
  version: "1.0.0",
  flow: [
    start(CodeChainWorkflowStart)
      .returns(LinkDto)
      .toRouter(DeeperRouter)
      .chooseOne(
        route(ThisWorkflow)
          .returns(LinkDoneDto)
          .toFinish(ChainDoneWorkflowFinish),
        route(LinkAgent)
          .returns(LinkDoneDto)
          .toFinish(ChainDoneWorkflowFinish),
      ),
  ],
  maxDepth: 2,
})
export class CodeChainWorkflow {}

@Application({
  name: "recursion-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    TopicResearchWorkflow,
    CountdownWorkflow,
    ShallowWorkflow,
    SplitWorkflow,
    ChainWorkflow,
    CodeChainWorkflow,
  ],
  defaults: { router: { model: "typesafe/jev-1.13" } },
  budgets: TEST_BUDGETS,
})
export class RecursionApplication {}
