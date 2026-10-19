import {
  action,
  caseOf,
  listOf,
  oneOf,
  start,
  StepFailedError,
  ThisWorkflow,
  toAction,
  Workflow,
} from "agboss";
import { MarkTopicFailedAction } from "./actions/mark-topic-failed.action.js";
import { SubtopicsAction } from "./actions/subtopics.action.js";
import { MergeAgent } from "./agents/merge.agent.js";
import { ResearcherAgent } from "./agents/researcher.agent.js";
import { TopicFailedDto } from "./dtos/topic-failed.dto.js";
import { TopicReportDto } from "./dtos/topic-report.dto.js";
import { TopicTooBroadDto } from "./dtos/topic-too-broad.dto.js";
import { TopicDto } from "./dtos/topic.dto.js";
import { TopicFailedWorkflowFinish } from "./workflow-finishes/topic-failed.workflow-finish.js";
import { TopicReportWorkflowFinish } from "./workflow-finishes/topic-report.workflow-finish.js";
import { TopicResearchWorkflowStart } from "./workflow-starts/topic-research.workflow-start.js";

/**
 * Recursion (#264): a topic too broad for one report is split, and each subtopic is researched by
 * this workflow itself — `ThisWorkflow`, one child execution per item — its results merged. At most
 * three levels (`maxDepth`): on the third the researcher can only report (the soft stop). At most
 * four executions of the tree work at once (`maxConcurrentExecutions`); the rest wait their turn.
 */
@Workflow({
  name: "topic-research-workflow",
  version: "1.0.0",
  flow: [
    start(TopicResearchWorkflowStart)
      .returns(TopicDto)
      .toAgent(ResearcherAgent)
      .onError(StepFailedError, toAction(MarkTopicFailedAction)) // a failed topic is skipped softly
      .returns(oneOf(TopicReportDto, TopicTooBroadDto))
      .switch(
        caseOf(TopicReportDto)
          .toFinish(TopicReportWorkflowFinish),
        caseOf(TopicTooBroadDto) // left out of the schema on the last level
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

    // two ways in (the researcher's error, the merge's error): its own path
    action(MarkTopicFailedAction)
      .returns(TopicFailedDto)
      .toFinish(TopicFailedWorkflowFinish),
  ],
  maxDepth: 3,
  maxConcurrentExecutions: 4,
})
export class TopicResearchWorkflow {}
