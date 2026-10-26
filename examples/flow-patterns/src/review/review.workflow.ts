import { listOf, start, StepFailedError, toFinish, Workflow } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { EditorialPlanAction } from "./actions/editorial-plan.action.js";
import { FactCheckerAgent } from "./agents/fact-checker.agent.js";
import { SectionReviewerAgent } from "./agents/section-reviewer.agent.js";
import { SectionSplitterAgent } from "./agents/section-splitter.agent.js";
import { StyleCriticAgent } from "./agents/style-critic.agent.js";
import { EditorialPlanDto } from "./dtos/editorial-plan.dto.js";
import { FactCheckDto } from "./dtos/fact-check.dto.js";
import { SectionReviewDto } from "./dtos/section-review.dto.js";
import { SectionDto } from "./dtos/section.dto.js";
import { StyleNotesDto } from "./dtos/style-notes.dto.js";
import { ReviewIncompleteWorkflowFinish } from "./workflow-finishes/review-incomplete.workflow-finish.js";
import { ReviewWorkflowFinish } from "./workflow-finishes/review.workflow-finish.js";
import { ReviewWorkflowStart } from "./workflow-starts/review.workflow-start.js";

/**
 * Parallel launches in waves (#273): one section reviewer per section of the manuscript (at most
 * 20, three at a time), a mapping action, then a style critic beside two fact checker copies. Each
 * join gives the next step its values: one review per section in the sections' order, then the
 * style notes and `listOf(FactCheckDto)` for the copies. A critic that fails takes the side path.
 */
@Workflow({
  name: "review-workflow",
  version: "1.0.0",
  flow: [
    start(ReviewWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SectionSplitterAgent)
      .returns(listOf(SectionDto))
      .toParallelAgents(SectionReviewerAgent, { maxConcurrency: 3, maxItems: 20 })
      .join()
      .returns(listOf(SectionReviewDto))
      .toAction(EditorialPlanAction)
      .returns(EditorialPlanDto)
      .toParallelAgents(StyleCriticAgent, FactCheckerAgent, FactCheckerAgent, { maxConcurrency: 2 })
      .join()
      .onJoinError(StepFailedError, toFinish(ReviewIncompleteWorkflowFinish))
      .returns(StyleNotesDto)
      .returns(listOf(FactCheckDto))
      .toFinish(ReviewWorkflowFinish),
  ],
  maxSteps: 30, // the worst case: the splitter, 20 section reviews and the three critics
})
export class ReviewWorkflow {}
