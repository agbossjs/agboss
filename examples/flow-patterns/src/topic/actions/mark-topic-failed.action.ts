import { Action, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { TopicFailedDto } from "../dtos/topic-failed.dto.js";
import { TopicDto } from "../dtos/topic.dto.js";

/** Records that a topic could not be researched: its own result, so its siblings go on. */
@Action({
  name: "mark-topic-failed-action",
  description: "Records that a topic could not be researched",
  input: {
    topic: TopicDto,
  },
  output: TopicFailedDto,
})
export class MarkTopicFailedAction implements ActionHandler<MarkTopicFailedAction> {
  execute(input: InputOf<MarkTopicFailedAction>): Promise<OutputOf<MarkTopicFailedAction>> {
    return Promise.resolve({ title: input.topic.value.title });
  }
}
