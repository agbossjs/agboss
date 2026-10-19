import { Agent, listOf, oneOf } from "agboss";
import { TopicFailedDto } from "../dtos/topic-failed.dto.js";
import { TopicReportDto } from "../dtos/topic-report.dto.js";
import { TopicDto } from "../dtos/topic.dto.js";

/** Merges the subtopics' results into one report: every child's result, in the subtopics' order. */
@Agent({
  name: "merge-agent",
  description: "Merges the subtopics' reports into one report on the topic",
  promptUrls: ["./merge.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    topic: TopicDto, // the start's input: the execution's own topic, never a subtopic
    results: listOf(oneOf(TopicReportDto, TopicFailedDto)), // the children's results, one per subtopic
  },
  output: TopicReportDto,
})
export class MergeAgent {}
