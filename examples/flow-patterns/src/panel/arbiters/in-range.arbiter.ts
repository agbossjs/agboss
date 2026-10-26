import { Arbiter, DecidedBy, OnAnswer, type ArbiterAnswerOf } from "@agboss/core";
import { CultureScoreAgent } from "../agents/culture-score.agent.js";
import { HireScoreAgent } from "../agents/hire-score.agent.js";
import { SkillsScoreAgent } from "../agents/skills-score.agent.js";

/**
 * By code (written by `agboss generate arbiter in-range --workflow src/panel/panel.workflow.ts`): a
 * score counts only from 1 to 10 — one method per panelist, one rule shared by a private method.
 * Cheap, so it runs first: the model arbiter is not asked about a score out of range.
 */
@Arbiter({
  name: "in-range-arbiter",
  decidedBy: DecidedBy.Code,
})
export class InRangeArbiter {
  @OnAnswer(SkillsScoreAgent)
  fromSkillsScore(answer: ArbiterAnswerOf<typeof SkillsScoreAgent>): boolean {
    return this.isInRange(answer.score);
  }

  @OnAnswer(CultureScoreAgent)
  fromCultureScore(answer: ArbiterAnswerOf<typeof CultureScoreAgent>): boolean {
    return this.isInRange(answer.score);
  }

  @OnAnswer(HireScoreAgent)
  fromHireScore(answer: ArbiterAnswerOf<typeof HireScoreAgent>): boolean {
    return this.isInRange(answer.score);
  }

  private isInRange(score: number): boolean {
    return score >= 1 && score <= 10;
  }
}
