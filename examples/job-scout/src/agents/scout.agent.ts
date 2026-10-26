import { Agent, RagMode } from "@agboss/core";
import { Reasoning } from "@agboss/core/models";
import { GreenhouseJobs } from "../tools/greenhouse-jobs.tool.js";
import { CompanyNotes } from "../rag/company-notes.rag.js";
import { KIMI } from "../config/settings.js";

@Agent({
  name: "scout-agent",
  promptUrls: ["./scout.prompt.md"],
  description:
    "Searches Greenhouse with the agreed search brief and returns the best-fitting jobs with links",
  model: KIMI,
  // a ceiling: a model stuck in a repetition loop stops here instead of generating for minutes
  maxTokens: 4000,
  // ranking is Jev's job; the scout only filters and formats — no reasoning to pay for
  reasoning: Reasoning.off(),
  tools: [GreenhouseJobs],
  rag: [{ use: CompanyNotes, mode: RagMode.Tool }],
})
export class ScoutAgent {}
