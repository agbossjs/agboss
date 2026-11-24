import {
  Arbiter,
  ArbiterModel,
  Arbitrate,
  Decision,
  Metadata,
  type ArbitratedAnswerOf,
} from "@agboss/core";
import { CultureScoreAgent } from "../../agents/culture-score/culture-score.agent.js";
import { HireScoreAgent } from "../../agents/hire-score/hire-score.agent.js";
import { SkillsScoreAgent } from "../../agents/skills-score/skills-score.agent.js";

type PanelAnswer = ArbitratedAnswerOf<
  [typeof SkillsScoreAgent, typeof CultureScoreAgent, typeof HireScoreAgent]
>;

/** What each panelist's reason must show: the criterion the model checks it against. */
const CRITERIA = new Map<unknown, string>([
  [SkillsScoreAgent, "The reason names a concrete technical skill"],
  [CultureScoreAgent, "The reason names a concrete trait of the team"],
  [HireScoreAgent, "The reason ends with a clear hire / no hire"],
]);

/**
 * One arbiter for the whole panel (#1282, #1283): a score counts when it is in range — decided by
 * code, at `$0`, first — and its reason meets the criterion of the panelist who gave it — decided by
 * the arbiter's own model, asked only about a score that is in range.
 */
@Arbiter({ name: "panel-score-arbiter", model: "typesafe/jev-1.13", deps: [ArbiterModel] })
export class PanelScoreArbiter {
  constructor(private readonly arbiterModel: ArbiterModel) {}

  @Arbitrate(SkillsScoreAgent, CultureScoreAgent, HireScoreAgent)
  async isCounted(answer: PanelAnswer): Promise<boolean> {
    if (answer.score < 1 || answer.score > 10) return false;
    const criterion = CRITERIA.get(Metadata.createdBy(answer)) ?? "The reason is concrete";
    const read = await this.arbiterModel.decide({
      state: `Score ${String(answer.score)}: ${answer.reason}`,
      questions: { counts: Decision.boolean(criterion) },
    });
    return read.counts.probability > 0.5;
  }
}
