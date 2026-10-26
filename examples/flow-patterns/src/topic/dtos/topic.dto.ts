import { Integer, Text } from "@agboss/core/dto";

/**
 * A topic to research: the start's input and the item of each child execution. `level` is domain
 * data — set by the action that splits a topic — never the execution's depth (#264 Q52): a model
 * reads it in its input, the framework stops the recursion on `maxDepth`.
 */
export class TopicDto {
  @Text({ prompt: "the topic" })
  title!: string;

  @Integer({ prompt: "how deep the topic is: 0 for the first one" })
  level!: number;
}
