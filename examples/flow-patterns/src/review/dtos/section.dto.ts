import { Text } from "agboss/dto";

/** One section of the manuscript: what a section reviewer reads (the item of its run). */
export class SectionDto {
  @Text({ prompt: "the section's title" })
  title!: string;

  @Text({ prompt: "the section's text" })
  text!: string;
}
