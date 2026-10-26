import { Agent, oneOf } from "@agboss/core";
import { TopicReportDto } from "../dtos/topic-report.dto.js";
import { TopicTooBroadDto } from "../dtos/topic-too-broad.dto.js";
import { TopicDto } from "../dtos/topic.dto.js";

/**
 * Researches one topic, or finds it too broad. On the last level (`depth === maxDepth`) the
 * framework leaves `TopicTooBroadDto` out of its response schema (#264, the soft stop).
 */
@Agent({
  name: "researcher-agent",
  description: "Researches one topic, or says it is too broad and lists its subtopics",
  promptUrls: ["./researcher.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    topic: TopicDto,
  },
  output: oneOf(TopicReportDto, TopicTooBroadDto),
})
export class ResearcherAgent {}
