import { Agent } from "@agboss/core";
import { EditorialPlanDto } from "../dtos/editorial-plan.dto.js";
import { StyleNotesDto } from "../dtos/style-notes.dto.js";

/** Reads the editorial plan for tone and style — beside the fact checkers. */
@Agent({
  name: "style-critic-agent",
  description: "Notes on tone and style",
  promptUrls: ["./style-critic.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    plan: EditorialPlanDto,
  },
  output: StyleNotesDto,
})
export class StyleCriticAgent {}
