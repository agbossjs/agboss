import { WorkflowFinish } from "agboss";
import { TopicReportDto } from "../dtos/topic-report.dto.js";

/** The report on the topic: researched here, or merged from its subtopics. */
@WorkflowFinish({
  name: "topic-report-workflow-finish",
  description: "The report on the topic",
  output: TopicReportDto,
})
export class TopicReportWorkflowFinish {}
