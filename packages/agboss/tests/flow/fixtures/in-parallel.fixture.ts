import { onStart, skip, toAgent, toRouter } from "../../../src/flow/builder.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import type { InputOf, RouterAnswerOf } from "../../../src/flow/generated-types.js";
import type { RouterHandler } from "../../../src/flow/handlers.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { ArticleDraftDto } from "./launch-dtos.js";
import { CritiqueDto, PlanDto, ResearchDto } from "./review-dtos.js";
import { CriticAgent, PlannerAgent, PlanResearcherAgent } from "./launch.fixture.js";
import { inline } from "../../../src/index.js";

/**
 * #1279 — `.inParallel([…])`: branches of any kind in one tuple, a branch's `.onError(E, skip())`
 * makes its value `optional(…)` in what the join gives.
 */

@WorkflowStart({
  name: "parallel-panel-workflow-start",
  description: "What to write about",
  input: WorkflowStartTextDto,
})
export class ParallelPanelWorkflowStart {}

@Agent({
  name: "parallel-panel-writer-agent",
  description: "Writes from the research and a critique, when there is one",
  prompt: inline("Write the article."),
  model: "moonshotai/kimi-k2.6",
  input: {
    plan: PlanDto,
    research: ResearchDto,
    critique: optional(CritiqueDto),
  },
  output: ArticleDraftDto,
})
export class ParallelPanelWriterAgent {}

@WorkflowFinish({
  name: "parallel-panel-workflow-finish",
  description: "The article",
  output: ArticleDraftDto,
})
export class ParallelPanelWorkflowFinish {}

@Workflow({
  name: "parallel-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(ParallelPanelWorkflowStart)
      .toAgent(PlannerAgent)
      .inParallel(
        [
          toAgent(PlanResearcherAgent),
          toAgent(CriticAgent)
            .onError(StepError, skip()),
        ],
        {
          maxConcurrency: 2,
        },
      )
      .join()
      .toAgent(ParallelPanelWriterAgent)
      .toFinish(ParallelPanelWorkflowFinish),
  ],
})
export class ParallelPanelWorkflow {}

// ── #1279b: a code router picks which branches run ──

@Router({
  name: "parallel-panel-router",
  description: "Picks which of the panel's branches run",
  decidedBy: DecidedBy.Code,
  input: { plan: PlanDto },
  routes: [PlanResearcherAgent, () => CriticAgent],
})
export class ParallelPanelRouter implements RouterHandler<ParallelPanelRouter> {
  route(input: InputOf<ParallelPanelRouter>): RouterAnswerOf<ParallelPanelRouter> {
    return input.plan.value.outline.length > 40
      ? [PlanResearcherAgent, CriticAgent]
      : [CriticAgent];
  }
}

@Agent({
  name: "chosen-panel-writer-agent",
  description: "Writes from whichever branches the router picked",
  prompt: inline("Write the article."),
  model: "moonshotai/kimi-k2.6",
  input: {
    plan: PlanDto,
    research: optional(ResearchDto),
    critique: optional(CritiqueDto),
  },
  output: ArticleDraftDto,
})
export class ChosenPanelWriterAgent {}

@Workflow({
  name: "chosen-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(ParallelPanelWorkflowStart)
      .toAgent(PlannerAgent)
      .inParallel([
        toRouter(ParallelPanelRouter)
          .chooseMany([
            toAgent(PlanResearcherAgent),
            toAgent(CriticAgent)
              .onError(StepError, skip()),
          ]),
      ])
      .join()
      .toAgent(ChosenPanelWriterAgent)
      .toFinish(ParallelPanelWorkflowFinish),
  ],
})
export class ChosenPanelWorkflow {}
