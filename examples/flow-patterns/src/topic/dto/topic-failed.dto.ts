import { Text } from "@agboss/core/dto";

/** A topic that could not be researched: a result of its own, so its siblings go on. */
export class TopicFailedDto {
  @Text({ prompt: "the topic" })
  title!: string;
}
