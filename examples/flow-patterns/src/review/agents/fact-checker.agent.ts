import { Agent } from "@agboss/core";
import { EditorialPlanDto } from "../dtos/editorial-plan.dto.js";
import { FactCheckDto } from "../dtos/fact-check.dto.js";

/** Checks the facts of the sections to rework; the flow launches two independent copies. */
@Agent({
  name: "fact-checker-agent",
  description: "Raises a claim to verify",
  promptUrls: ["./fact-checker.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    plan: EditorialPlanDto,
  },
  output: FactCheckDto,
})
export class FactCheckerAgent {}
