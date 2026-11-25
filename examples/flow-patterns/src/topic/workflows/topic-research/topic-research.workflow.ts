import {
  onAction,
  onStart,
  StepFailedError,
  toAction,
  Workflow,
  toWorkflow,
  toFinish,
  Ttl,
} from "@agboss/core";
import { MarkTopicFailedAction } from "../../actions/mark-topic-failed.action.js";
import { SubtopicsAction } from "../../actions/subtopics.action.js";
import { MergeAgent } from "../../agents/merge/merge.agent.js";
import { ResearcherAgent } from "../../agents/researcher/researcher.agent.js";
import { TopicFailedWorkflowFinish } from "./topic-failed.workflow-finish.js";
import { TopicReportWorkflowFinish } from "./topic-report.workflow-finish.js";
import { TopicResearchWorkflowStart } from "./topic-research.workflow-start.js";

/**
 * Recursion (#264): a topic too broad for one report is split, and each subtopic is researched by
 * this workflow itself — `() => TopicResearchWorkflow`, one child execution per item — its results merged. At most
 * three levels (`executionLimits.maxDepth`): on the third the researcher can only report (the soft stop). At most
 * four executions of the tree work at once (`executionLimits.maxConcurrency`); the rest wait their turn.
 */
@Workflow({
  name: "topic-research-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TopicResearchWorkflowStart)
      .toAgent(ResearcherAgent)
      .onError(StepFailedError, toAction(MarkTopicFailedAction)) // a failed topic is skipped softly
      .toOneOf([
        toFinish(TopicReportWorkflowFinish),
        // the action reads the too-broad topic: left out of the schema on the last level
        toAction(SubtopicsAction)
          .forEachItem(
            toWorkflow(() => TopicResearchWorkflow),
            { takeFirst: 5, maxConcurrency: 3 },
          )
          .join()
          .toAgent(MergeAgent)
          .onError(StepFailedError, toAction(MarkTopicFailedAction))
          .toFinish(TopicReportWorkflowFinish),
      ]),

    // two ways in (the researcher's error, the merge's error): its own path
    onAction(MarkTopicFailedAction)
      .toFinish(TopicFailedWorkflowFinish),
  ],
  executionLimits: { maxDepth: 3, maxConcurrency: 4 },
})
export class TopicResearchWorkflow {}
