import { List, Text } from "@agboss/core/dto";

/** A topic too broad for one report: its subtopics, each researched the same way. */
export class TopicTooBroadDto {
  @List(Text, { prompt: "the subtopics" })
  subtopics!: string[];
}
