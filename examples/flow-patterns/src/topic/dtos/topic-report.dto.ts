import { Text } from "agboss/dto";

/** A report on one topic. */
export class TopicReportDto {
  @Text({ prompt: "the topic" })
  title!: string;

  @Text({ prompt: "the report" })
  text!: string;
}
