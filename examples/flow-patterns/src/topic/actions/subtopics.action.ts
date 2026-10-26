import { Action, listOf, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { TopicTooBroadDto } from "../dtos/topic-too-broad.dto.js";
import { TopicDto } from "../dtos/topic.dto.js";

/** Splits a topic that is too broad: fewer branches deeper down, each one level further. */
@Action({
  name: "subtopics-action",
  description: "Splits a topic that is too broad into subtopics",
  input: {
    topic: TopicDto,
    tooBroad: TopicTooBroadDto,
  },
  output: listOf(TopicDto),
})
export class SubtopicsAction implements ActionHandler<SubtopicsAction> {
  execute(input: InputOf<SubtopicsAction>): Promise<OutputOf<SubtopicsAction>> {
    const { level } = input.topic.value;
    const limit: number = level < 1 ? 5 : 3;
    const subtopics: TopicDto[] = input.tooBroad.value.subtopics
      .slice(0, limit)
      .map((title: string): TopicDto => ({ title, level: level + 1 })); // the domain level (Q52)
    return Promise.resolve(subtopics);
  }
}
