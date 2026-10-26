import { ListOf, Text } from "@agboss/core/dto";

/** A topic too broad for one report: its subtopics, each researched the same way. */
export class TopicTooBroadDto {
  @ListOf(Text, { prompt: "the subtopics" })
  subtopics!: string[];
}
