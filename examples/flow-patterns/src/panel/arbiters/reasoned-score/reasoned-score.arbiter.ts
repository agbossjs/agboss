import { Arbiter } from "@agboss/core";
import { CultureScoreAgent } from "../../agents/culture-score/culture-score.agent.js";
import { HireScoreAgent } from "../../agents/hire-score/hire-score.agent.js";
import { SkillsScoreAgent } from "../../agents/skills-score/skills-score.agent.js";

/** By model: a score counts only when its reason meets the criterion of the panelist who gave it. */
@Arbiter({
  name: "reasoned-score-arbiter",
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { target: SkillsScoreAgent, prompt: "The reason names a concrete technical skill" },
    { target: CultureScoreAgent, prompt: "The reason names a concrete trait of the team" },
    { target: HireScoreAgent, prompt: "The reason ends with a clear hire / no hire" },
  ],
})
export class ReasonedScoreArbiter {}
