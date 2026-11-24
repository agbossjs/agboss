import { Arbiter, Arbitrate, type ArbitratedAnswerOf } from "@agboss/core";
import { CultureScoreAgent } from "../../agents/culture-score/culture-score.agent.js";
import { HireScoreAgent } from "../../agents/hire-score/hire-score.agent.js";
import { SkillsScoreAgent } from "../../agents/skills-score/skills-score.agent.js";

/**
 * By code (written by
 * `agboss generate arbiter in-range --workflow src/panel/workflows/panel/panel.workflow.ts`): a score
 * counts only from 1 to 10 — one method for all panelists, since they answer the same DTO.
 * Cheap, so it runs first: the model arbiter is not asked about a score out of range.
 */
@Arbiter({
  name: "in-range-arbiter",
})
export class InRangeArbiter {
  @Arbitrate(SkillsScoreAgent, CultureScoreAgent, HireScoreAgent)
  isInRange(
    answer: ArbitratedAnswerOf<
      [typeof SkillsScoreAgent, typeof CultureScoreAgent, typeof HireScoreAgent]
    >,
  ): boolean {
    return answer.score >= 1 && answer.score <= 10;
  }
}
