import { WorkflowStart } from "@agboss/core";
import { TopicDto } from "../../dto/topic.dto.js";

/** Where a topic's research starts: the first topic, or each subtopic of a level above. */
@WorkflowStart({
  name: "topic-research-workflow-start",
  description: "A topic to research",
  input: TopicDto,
})
export class TopicResearchWorkflowStart {}
