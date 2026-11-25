import { onAgent, onStart, toAgent, toFinish } from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { DraftChangesDto } from "./data-dtos.js";
import { ArticleDto, ArticleRequestDto } from "./dtos.js";
import { ApprovalDto, CritiqueDto, DraftDto, ResearchDto } from "./review-dtos.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "./budgets.js";
import { EmptyEnvironment, inline, Ttl } from "../../../src/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #271 — the review loop (`caseOf(…)` after the reviewer, #299) and a polish
 * loop (an action's ``).
 */

@WorkflowStart({
  name: "story-workflow-start",
  description: "What to write about",
  input: ArticleRequestDto,
})
export class StoryWorkflowStart {}

@Agent({
  name: "researcher-agent",
  description: "Researches the subject",
  prompt: inline("Research the subject."),
  model: "moonshotai/kimi-k2.6",
  input: {
    request: ArticleRequestDto,
  },
  output: ResearchDto,
})
export class ResearcherAgent {}

@Agent({
  name: "story-writer-agent",
  description: "Writes the article, or rewrites it from the reviewer's notes",
  prompt: inline("Write the article."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 4 },
  input: {
    request: ArticleRequestDto,
    research: ResearchDto,
    changes: optional(DraftChangesDto), // the first draft has none
  },
  output: DraftDto,
})
export class StoryWriterAgent {}

@Agent({
  name: "story-reviewer-agent",
  description: "Approves the draft or asks for changes",
  prompt: inline("Review the draft."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 4 },
  input: {
    draft: DraftDto,
  },
  output: oneOf(ApprovalDto, DraftChangesDto), // both answers are about the draft: in the flow
})
export class StoryReviewerAgent {}

@Agent({
  name: "publisher-agent",
  description: "Prepares the approved draft for publishing",
  prompt: inline("Prepare the draft."),
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: DraftDto,
    approval: ApprovalDto, // current only while it is about the latest draft
  },
  output: ArticleDto,
})
export class PublisherAgent {}

@WorkflowFinish({
  name: "story-workflow-finish",
  description: "The article, ready to publish",
  output: ArticleDto,
})
export class StoryWorkflowFinish {}

export const storyPaths = [
  onStart(StoryWorkflowStart)
    .toAgent(ResearcherAgent)
    .toAgent(StoryWriterAgent),

  onAgent(StoryWriterAgent)
    .toAgent(StoryReviewerAgent)
    .toOneOf([
      toAgent(StoryWriterAgent),
      toAgent(PublisherAgent)
        .toFinish(StoryWorkflowFinish),
    ]),
] as const;

@Workflow({
  name: "story-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: storyPaths,
})
export class StoryWorkflow {}

@Application({
  name: "story-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [StoryWorkflow],
  budgets: TEST_BUDGETS,
})
export class StoryApplication {}

@Agent({
  name: "polish-agent",
  description: "Polishes the draft by the critiques",
  prompt: inline("Polish the draft."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 3 },
  input: {
    request: ArticleRequestDto,
    critiques: optional(listOf(CritiqueDto)),
  },
  output: DraftDto,
})
export class PolishAgent {}

/** A code critic: its answers are about the draft it read (`OutputOf<Self>` is the list). */
@Action({
  name: "critique-action",
  description: "Lists what is wrong with the draft",
  input: {
    draft: DraftDto,
  },
  output: listOf(CritiqueDto),
})
export class CritiqueAction implements ActionHandler<CritiqueAction> {
  execute(input: InputOf<CritiqueAction>): Promise<OutputOf<CritiqueAction>> {
    return Promise.resolve([{ remark: `shorter than ${String(input.draft.text.length)}` }]);
  }
}

@WorkflowFinish({
  name: "polished-workflow-finish",
  description: "The polished draft",
  output: DraftDto,
})
export class PolishedWorkflowFinish {}

@Router({
  name: "critique-router",
  description: "Polishes again or stops",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  maxVisits: 3,
  input: {
    critiques: listOf(CritiqueDto),
  },
  routes: [
    { target: PolishAgent, prompt: "The critiques ask for changes" },
    { target: PolishedWorkflowFinish, prompt: "Stop and send the draft: nothing to fix" },
  ],
})
export class CritiqueRouter {}

@Workflow({
  name: "polish-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(StoryWorkflowStart)
      .toAgent(PolishAgent),
    onAgent(PolishAgent)
      .toAction(CritiqueAction)
      .toRouter(CritiqueRouter)
      .onRoute(toAgent(PolishAgent))
      .onRoute(toFinish(PolishedWorkflowFinish)),
  ],
})
export class PolishWorkflow {}

@Application({
  name: "polish-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PolishWorkflow],
  budgets: TEST_BUDGETS,
})
export class PolishApplication {}
