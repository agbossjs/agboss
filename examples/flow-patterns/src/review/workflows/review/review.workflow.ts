import { onStart, StepFailedError, toFinish, Workflow, toAgent } from "@agboss/core";
import { EditorialPlanAction } from "../../actions/editorial-plan.action.js";
import { ReviewReportAction } from "../../actions/review-report.action.js";
import { FactCheckerAgent } from "../../agents/fact-checker/fact-checker.agent.js";
import { SectionReviewerAgent } from "../../agents/section-reviewer/section-reviewer.agent.js";
import { SectionSplitterAgent } from "../../agents/section-splitter/section-splitter.agent.js";
import { StyleCriticAgent } from "../../agents/style-critic/style-critic.agent.js";
import { ReviewIncompleteWorkflowFinish } from "./review-incomplete.workflow-finish.js";
import { ReviewWorkflowFinish } from "./review.workflow-finish.js";
import { ReviewWorkflowStart } from "./review.workflow-start.js";

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
    onStart(ReviewWorkflowStart)
      .toAgent(SectionSplitterAgent)
      .forEachItem(toAgent(SectionReviewerAgent), { takeFirst: 20, maxConcurrency: 3 })
      .join()
      .toAction(EditorialPlanAction)
      .inParallel(
        [toAgent(StyleCriticAgent), toAgent(FactCheckerAgent), toAgent(FactCheckerAgent)],
        { maxConcurrency: 2 },
      )
      .join()
      .onError(StepFailedError, toFinish(ReviewIncompleteWorkflowFinish))
      .toAction(ReviewReportAction)
      .toFinish(ReviewWorkflowFinish),
  ],
  executionLimits: { maxSteps: 30 }, // the worst case: the splitter, 20 section reviews and the three critics
})
export class ReviewWorkflow {}
