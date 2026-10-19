import { WorkflowFinish } from "agboss";
import { TopicFailedDto } from "../dtos/topic-failed.dto.js";

/** The topic could not be researched: a finish reachable from a side path (no FailFast for its siblings). */
@WorkflowFinish({
  name: "topic-failed-workflow-finish",
  description: "The topic could not be researched",
  output: TopicFailedDto,
})
export class TopicFailedWorkflowFinish {}
