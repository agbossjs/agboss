import { Text } from "@agboss/core/dto";

/** A report on one topic. */
export class TopicReportDto {
  @Text({ prompt: "the topic" })
  title!: string;

  @Text({ prompt: "the report" })
  text!: string;
}
