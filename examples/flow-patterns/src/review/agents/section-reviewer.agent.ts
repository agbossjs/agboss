import { Agent } from "@agboss/core";
import { SectionDto } from "../dtos/section.dto.js";
import { SectionReviewDto } from "../dtos/section-review.dto.js";

/** Reviews one section: launched once per item of the splitter's list (`maxItems` bounds it). */
@Agent({
  name: "section-reviewer-agent",
  description: "Reviews one section",
  promptUrls: ["./section-reviewer.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    section: SectionDto, // the item of this run
  },
  output: SectionReviewDto,
})
export class SectionReviewerAgent {}
