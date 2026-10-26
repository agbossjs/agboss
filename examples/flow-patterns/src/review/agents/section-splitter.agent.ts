import { Agent, listOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SectionDto } from "../dtos/section.dto.js";

/** Splits the manuscript into its sections: the list the next launch runs over, in order. */
@Agent({
  name: "section-splitter-agent",
  description: "Splits the manuscript into sections",
  promptUrls: ["./section-splitter.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    manuscript: WorkflowStartTextDto,
  },
  output: listOf(SectionDto),
})
export class SectionSplitterAgent {}
